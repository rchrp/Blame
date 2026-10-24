import * as React from "react"
import type {
  AgentEvent,
  PreviewManifest,
  ProjectRunConfiguration,
} from "@blame/agent-runtime"
import { toast } from "sonner"

import { useModelSelection } from "@/components/model/model-selection"
import { newProjectHostDependencyScript } from "@/components/new-project/new-project-host-dependencies"
import {
  defaultNewProjectConfiguration,
  normalizeNewProjectConfiguration,
  type AdvancedProjectOption,
  type BackendFramework,
  type CodeQualityOption,
  type DatabaseOption,
  type FrontendFramework,
  type NewProjectConfiguration,
  type OrmOption,
  type PackageManager,
  type ProjectPlatform,
  type StylingOption,
  type UiLibrary,
} from "@/components/new-project/new-project-options"
import { usePlatform } from "@/context/platform"
import type { HostDependencyReport } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { useCloudAuth } from "@/context/cloud-auth"
import { CloudApiError } from "@/lib/cloud-api"

export type NewProjectStep =
  | "location"
  | "platform"
  | "frontend"
  | "styling"
  | "backend"
  | "data"
  | "quality"
  | "advanced"
  | "summary"
  | "progress"

export type ProjectCreationLog = {
  type: "stdout" | "stderr" | "exit" | "agent"
  data: string
  channel?: "reasoning" | "text" | "tool" | "notice"
  append?: boolean
}

export type ProjectCreationStatus =
  | "idle"
  | "preparing"
  | "generating"
  | "installing"
  | "verifying"
  | "done"
  | "error"

const steps: NewProjectStep[] = [
  "location",
  "platform",
  "frontend",
  "styling",
  "backend",
  "data",
  "quality",
  "advanced",
  "summary",
]
const maxInitializationCompletionAttempts = 3

type InitializationFeedback = {
  validationError: string
  previousResult: string
}

type GeneratedProjectInitializationResult = {
  sessionId: string
  previewManifest: PreviewManifest
  runConfigurations: ProjectRunConfiguration[]
}

export type NewProjectWizard = ReturnType<typeof useNewProjectWizard>

export function useNewProjectWizard(input: {
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const platform = usePlatform()
  const projects = useProjects()
  const auth = useCloudAuth()
  const modelSelection = useModelSelection({ role: "alternative" })
  const [step, setStep] = React.useState<NewProjectStep>("location")
  const [parentPath, setParentPath] = React.useState("")
  const [projectName, setProjectName] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [logs, setLogs] = React.useState<ProjectCreationLog[]>([])
  const [status, setStatus] = React.useState<ProjectCreationStatus>("idle")
  const [hostDependenciesDialog, setHostDependenciesDialog] =
    React.useState<HostDependenciesDialogState>()
  const [configuration, setConfiguration] = React.useState(
    defaultNewProjectConfiguration
  )
  const normalizedConfiguration = React.useMemo(
    () => normalizeNewProjectConfiguration(configuration),
    [configuration]
  )
  const currentStepIndex = Math.max(steps.indexOf(step), 0)
  const canGoBack = !creating && currentStepIndex > 0
  const canGoNext = !creating && nextStepAllowed(step, parentPath, projectName)
  const createProjectAvailable = Boolean(
    platform.workspace?.createProject &&
    platform.agent &&
    modelSelection.currentModel
  )

  const reset = React.useCallback(() => {
    setStep("location")
    setParentPath("")
    setProjectName("")
    setCreating(false)
    setError(undefined)
    setLogs([])
    setStatus("idle")
    setConfiguration(defaultNewProjectConfiguration)
  }, [])

  async function chooseParentPath() {
    const result = await platform.openDirectoryPickerDialog?.({
      title: "Choose New Project Location",
    })
    const path = Array.isArray(result) ? result[0] : result
    if (path) setParentPath(path)
  }

  function updateConfiguration(
    nextConfiguration: Partial<NewProjectConfiguration>
  ) {
    setConfiguration((current) =>
      normalizeNewProjectConfiguration({ ...current, ...nextConfiguration })
    )
  }

  function setPlatform(value: ProjectPlatform) {
    updateConfiguration({ platform: value })
  }

  function setFrontend(value: FrontendFramework) {
    updateConfiguration({ frontend: value, uiLibrary: defaultUi(value) })
  }

  function setStyling(value: StylingOption) {
    updateConfiguration({ styling: value })
  }

  function setUiLibrary(value: UiLibrary) {
    updateConfiguration({ uiLibrary: value })
  }

  function setBackend(value: BackendFramework) {
    updateConfiguration({ backend: value })
  }

  function setDatabase(value: DatabaseOption) {
    updateConfiguration({ database: value })
  }

  function setOrm(value: OrmOption) {
    updateConfiguration({ orm: value })
  }

  function setPackageManager(value: PackageManager) {
    updateConfiguration({ packageManager: value })
  }

  function setCodeQuality(value: CodeQualityOption) {
    updateConfiguration({ codeQuality: value })
  }

  function toggleAdvancedOption(value: AdvancedProjectOption) {
    setConfiguration((current) =>
      normalizeNewProjectConfiguration({
        ...current,
        advancedOptions: current.advancedOptions.includes(value)
          ? current.advancedOptions.filter((item) => item !== value)
          : [...current.advancedOptions, value],
      })
    )
  }

  function goBack() {
    const previousStep = steps[currentStepIndex - 1]
    if (previousStep) setStep(previousStep)
  }

  function goNext() {
    const nextStep = steps[currentStepIndex + 1]
    if (nextStep) setStep(nextStep)
  }

  async function createProject() {
    const workspace = platform.workspace
    if (!workspace?.createProject) {
      setError("Project creation is available only in the desktop app.")
      return
    }
    if (!workspace.checkHostDependencies) {
      setError("Desktop host dependency checks are not available.")
      return
    }

    setCreating(true)
    setError(undefined)
    setStatus("preparing")

    try {
      if (auth.status !== "authenticated") {
        throw new Error(
          "Sign in to Blame before generating a project with the AI agent."
        )
      }
      if (!platform.agent || !modelSelection.currentModel) {
        throw new Error(
          "Connect and select an AI model before generating a project."
        )
      }
      const setupScript = newProjectHostDependencyScript(
        normalizedConfiguration
      )
      // The project is generated on this machine: host tools only.
      const dependencies = await workspace.checkHostDependencies({
        includeRuntime: false,
        setupScript,
      })
      if (!dependencies.ok) {
        setHostDependenciesDialog({
          checking: false,
          report: dependencies,
          setupScript,
        })
        setCreating(false)
        return
      }
      await runProjectCreation()
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to check project requirements."
      )
      setStatus("error")
      setCreating(false)
    }
  }

  async function runProjectCreation() {
    const workspace = platform.workspace
    if (!workspace?.createProject) return
    setLogs([])
    setStep("progress")
    setStatus("preparing")

    const runId = crypto.randomUUID()
    const unsubscribe = workspace.onProjectCreationEvent?.(runId, (event) => {
      setLogs((current) => appendProjectCreationLog(current, event))
      setStatus(statusFromProjectCreationEvent(event))
    })
    const unsubscribeAgent = platform.agent?.sessions.onEvent(
      runId,
      (event) => {
        const log = projectCreationLogFromAgentEvent(event)
        if (log) setLogs((current) => appendProjectCreationLog(current, log))
        setStatus(statusFromAgentEvent(event))
        if (event.type === "error") {
          setError(
            eventText(event.payload) || "Project generation agent failed."
          )
        }
      }
    )

    try {
      const currentModel = modelSelection.currentModel
      const agent = platform.agent
      if (auth.status !== "authenticated" || !currentModel || !agent) {
        throw new Error("AI model selection is required to create a project.")
      }
      const createdProject = await workspace.createProject({
        apiConnection: auth.apiConnection,
        configuration: normalizedConfiguration,
        credentialLabel: currentModel.credentialLabel,
        modelId: currentModel.id,
        parentPath,
        projectName,
        providerId: currentModel.provider.id,
        reasoningEffort: modelSelection.currentVariant,
        runId,
      })
      setStatus("verifying")
      setLogs((current) =>
        appendProjectCreationLog(current, {
          type: "agent",
          channel: "notice",
          data: "Initializing generated project for Blame...\n",
        })
      )
      await initializeGeneratedProjectForBlame({
        agent,
        apiConnection: auth.apiConnection,
        model: currentModel,
        openGeneratedProject: projects.openGeneratedProject,
        path: createdProject.path,
        reasoningEffort: modelSelection.currentVariant,
        appendLog(log) {
          setLogs((current) => appendProjectCreationLog(current, log))
        },
      })
      setOpen(false)
      toast.success("Project created", {
        description: `${projectName.trim()} is ready in Blame.`,
      })
      setStatus("done")
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to create project."
      )
      setStatus("error")
    } finally {
      unsubscribe?.()
      unsubscribeAgent?.()
      setCreating(false)
    }
  }

  async function recheckHostDependencies() {
    const current = hostDependenciesDialog
    const workspace = platform.workspace
    if (!current || !workspace?.checkHostDependencies) return
    setHostDependenciesDialog({ ...current, checking: true })
    try {
      const report = await workspace.checkHostDependencies({
        includeRuntime: false,
        setupScript: current.setupScript,
      })
      if (report.ok) {
        setHostDependenciesDialog(undefined)
        setCreating(true)
        await runProjectCreation()
        return
      }
      setHostDependenciesDialog({ ...current, checking: false, report })
    } catch (error) {
      setHostDependenciesDialog({ ...current, checking: false })
      setError(
        error instanceof Error
          ? error.message
          : "Unable to recheck project requirements."
      )
      setStatus("error")
    }
  }

  function setOpen(open: boolean) {
    if (!open) reset()
    input.onOpenChange(open)
  }

  return {
    canGoBack,
    canGoNext,
    chooseParentPath,
    configuration: normalizedConfiguration,
    createProject,
    createProjectAvailable,
    creating,
    currentStepIndex,
    error,
    goBack,
    goNext,
    hostDependenciesDialog: {
      checking: Boolean(hostDependenciesDialog?.checking),
      onOpenChange(open: boolean) {
        if (!open) setHostDependenciesDialog(undefined)
      },
      onRecheck: recheckHostDependencies,
      open: Boolean(hostDependenciesDialog),
      report: hostDependenciesDialog?.report,
    },
    logs,
    parentPath,
    projectName,
    setBackend,
    setCodeQuality,
    setDatabase,
    setFrontend,
    setOrm,
    setPackageManager,
    setParentPath,
    setOpen,
    setPlatform,
    setProjectName,
    setStep,
    setStyling,
    setUiLibrary,
    step,
    steps,
    status,
    toggleAdvancedOption,
  }
}

type HostDependenciesDialogState = {
  checking: boolean
  report: HostDependencyReport
  setupScript: string
}

function nextStepAllowed(
  step: NewProjectStep,
  parentPath: string,
  projectName: string
) {
  if (step !== "location") return true
  return Boolean(parentPath.trim() && projectName.trim())
}

function defaultUi(frontend: FrontendFramework): UiLibrary {
  if (frontend === "nuxt") return "nuxt-ui"
  if (frontend === "vue-vite") return "primevue"
  if (frontend === "sveltekit") return "shadcn-svelte"
  if (frontend === "next" || frontend === "react-vite") return "shadcn"
  return "none"
}

function statusFromProjectCreationEvent(
  event: ProjectCreationLog
): ProjectCreationStatus {
  if (event.type === "exit") return "done"
  if (/preparing/i.test(event.data)) return "preparing"
  if (/install|dependencies/i.test(event.data)) return "installing"
  if (/verify|build|lint|test|preview/i.test(event.data)) return "verifying"
  return "generating"
}

function statusFromAgentEvent(event: AgentEvent): ProjectCreationStatus {
  if (event.type === "done") return "done"
  if (event.type === "error") return "error"
  const text = eventText(event.payload)
  if (/install|dependencies/i.test(text)) return "installing"
  if (/verify|build|lint|test|preview/i.test(text)) return "verifying"
  return "generating"
}

function projectCreationLogFromAgentEvent(
  event: AgentEvent
): ProjectCreationLog | undefined {
  const text = projectCreationEventText(event)
  if (text.value === undefined || text.value === "") return undefined
  if (event.type === "tool")
    return { type: "agent", channel: "tool", data: `[tool] ${text.value}\n` }
  if (event.type === "notice") {
    if (isNoisyAgentNotice(text.value)) return undefined
    return { type: "agent", channel: "notice", data: `${text.value}\n` }
  }
  if (event.type === "reasoning")
    return {
      type: "agent",
      channel: "reasoning",
      data: `Planning: ${text.value}\n`,
      append: text.append,
    }
  if (event.type === "text")
    return {
      type: "agent",
      channel: "text",
      data: `${text.value}\n`,
      append: text.append,
    }
  return {
    type: event.type === "error" ? "stderr" : "agent",
    data: `${text.value}\n`,
  }
}

function appendProjectCreationLog(
  current: ProjectCreationLog[],
  next: ProjectCreationLog
) {
  if (!next.channel) return [...current, next]
  const last = current.at(-1)
  if (last?.channel === next.channel)
    return [
      ...current.slice(0, -1),
      next.append ? appendStreamingProjectCreationLog(last, next) : next,
    ]
  if (last?.data === next.data) return current
  return [...current, next]
}

function projectCreationEventText(event: AgentEvent) {
  if (event.type === "reasoning" || event.type === "text") {
    const accumulatedText = eventAccumulatedText(event.payload)
    if (accumulatedText !== undefined) {
      return { value: accumulatedText, append: false }
    }
    const deltaText = eventDeltaText(event.payload)
    if (deltaText !== undefined) return { value: deltaText, append: true }
    return { value: eventText(event.payload), append: false }
  }
  return { value: eventText(event.payload), append: false }
}

function eventAccumulatedText(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined
  const value = (payload as Record<string, unknown>).accumulatedText
  return typeof value === "string" ? cleanEventText(value) : undefined
}

function eventDeltaText(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined
  const value = (payload as Record<string, unknown>).text
  return typeof value === "string" ? compactEventText(value) : undefined
}

function appendStreamingProjectCreationLog(
  last: ProjectCreationLog,
  next: ProjectCreationLog
) {
  const prefix = next.channel === "reasoning" ? "Planning: " : ""
  const currentText = channelLogText(last.data, prefix)
  const nextText = channelLogText(next.data, prefix)
  const mergedText = nextText.startsWith(currentText)
    ? nextText
    : `${currentText}${nextText}`
  return { ...next, data: `${prefix}${mergedText}\n` }
}

function channelLogText(data: string, prefix: string) {
  const text =
    prefix && data.startsWith(prefix) ? data.slice(prefix.length) : data
  return text.endsWith("\n") ? text.slice(0, -1) : text
}

function eventText(payload: unknown): string {
  if (typeof payload === "string") return cleanEventText(payload)
  if (!payload || typeof payload !== "object") return ""
  const record = payload as Record<string, unknown>
  for (const key of ["message", "text", "accumulatedText", "reason", "error"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return cleanEventText(value)
  }
  const tool = record.toolName ?? record.name
  if (typeof tool === "string") return `Running ${tool}`
  return ""
}

function cleanEventText(value: string) {
  return compactEventText(value).trim()
}

function compactEventText(value: string) {
  return value.replace(/\n{3,}/g, "\n\n")
}

async function initializeGeneratedProjectForBlame(input: {
  agent: NonNullable<ReturnType<typeof usePlatform>["agent"]>
  apiConnection: ReturnType<typeof useCloudAuth>["apiConnection"]
  model: NonNullable<ReturnType<typeof useModelSelection>["currentModel"]>
  openGeneratedProject: ReturnType<typeof useProjects>["openGeneratedProject"]
  path: string
  reasoningEffort: ReturnType<typeof useModelSelection>["currentVariant"]
  appendLog(log: ProjectCreationLog): void
}) {
  let validationFeedback: InitializationFeedback | undefined
  for (
    let attempt = 1;
    attempt <= maxInitializationCompletionAttempts;
    attempt += 1
  ) {
    const initialization = await runGeneratedProjectInitialization(
      input,
      validationFeedback
    )
    try {
      await openGeneratedProjectWithInitialization(input, initialization)
      return
    } catch (error) {
      if (!shouldRetryInitializationCompletion(error, attempt)) throw error
      validationFeedback = initializationValidationFeedback(
        error,
        initialization
      )
      input.appendLog(refiningInitializationLog())
    }
  }
}

function runGeneratedProjectInitialization(
  input: Parameters<typeof initializeGeneratedProjectForBlame>[0],
  validationFeedback: InitializationFeedback | undefined
) {
  return input.agent.initializations.run({
    apiConnection: input.apiConnection,
    providerId: input.model.provider.id,
    modelId: input.model.id,
    credentialLabel: input.model.credentialLabel,
    reasoningEffort: input.reasoningEffort,
    cwd: input.path,
    workspaceRoot: input.path,
    validationFeedback,
  })
}

function openGeneratedProjectWithInitialization(
  input: Parameters<typeof initializeGeneratedProjectForBlame>[0],
  initialization: GeneratedProjectInitializationResult
) {
  return input.openGeneratedProject(input.path, {
    clineSessionId: initialization.sessionId,
    previewManifest: initialization.previewManifest,
    runConfigurations: initialization.runConfigurations,
  })
}

function refiningInitializationLog(): ProjectCreationLog {
  return {
    type: "agent",
    channel: "notice",
    data: "Refining Blame initialization artifacts...\n",
  }
}

function isNoisyAgentNotice(text: string) {
  return /^Agent iteration (?:started|completed)\.$/.test(text)
}

function shouldRetryInitializationCompletion(error: unknown, attempt: number) {
  return (
    attempt < maxInitializationCompletionAttempts &&
    error instanceof CloudApiError &&
    [400, 422].includes(error.status)
  )
}

function initializationValidationFeedback(
  error: unknown,
  result: {
    previewManifest: PreviewManifest
    runConfigurations: ProjectRunConfiguration[]
  }
) {
  return {
    validationError: errorMessage(error),
    previousResult: JSON.stringify({
      previewManifest: result.previewManifest,
      runConfigurations: result.runConfigurations,
    }),
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
