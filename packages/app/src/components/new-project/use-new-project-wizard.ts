import * as React from "react"
import type {
  PreviewManifest,
  ProjectRunConfiguration,
} from "@blame/agent-runtime"
import type {
  EngineModelChoice,
  EnginePlatformClient,
  InitializationFeedback,
} from "@blame/agent-runtime/engine-protocol"
import type { SessionRecord } from "@blame/engine-client"
import { toast } from "sonner"
import { projectNameError } from "@blame/agent-runtime/project-name"

import { useModelSelection } from "@/components/model/model-selection"
import { newProjectHostDependencyScript } from "@/components/new-project/new-project-host-dependencies"
import {
  newProjectPath,
  useNewProjectLocation,
} from "./use-new-project-location"
import {
  defaultNewProjectConfiguration,
  normalizeNewProjectConfiguration,
  recommendedUiLibrary,
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
import { engineModelChoice } from "@/lib/agent-title-generation"
import { followEngineTask } from "@/lib/engine-task-follow"

import {
  newProjectSteps,
  type NewProjectMode,
  type NewProjectStep,
} from "./new-project-flow"
import { useNewProjectPlanning } from "./use-new-project-planning"
export type { NewProjectStep } from "./new-project-flow"

export type ProjectCreationLog = {
  type: "stdout" | "stderr" | "exit" | "agent"
  data: string
  channel?: "notice"
}

export type ProjectCreationStatus =
  | "idle"
  | "preparing"
  | "generating"
  | "installing"
  | "verifying"
  | "done"
  | "error"

const maxInitializationCompletionAttempts = 3

export type NewProjectWizard = ReturnType<typeof useNewProjectWizard>

export function useNewProjectWizard(input: {
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const platform = usePlatform()
  const projects = useProjects()
  const auth = useCloudAuth()
  // Talking with the agent uses the agent model; creating and setting up
  // the project uses the alternative model.
  const modelSelection = useModelSelection({ role: "alternative" })
  const planningSelection = useModelSelection({ role: "agent" })
  const [mode, setMode] = React.useState<NewProjectMode>()
  const steps = newProjectSteps(mode)
  const [step, setStepState] = React.useState<NewProjectStep>("location")
  const [parentPath, setParentPath] = React.useState("")
  const [projectName, setProjectName] = React.useState("")
  const planning = useNewProjectPlanning({
    open: input.open,
    parentPath,
    projectName,
    selection: planningSelection,
  })
  const [ownedTargetKey, setOwnedTargetKey] = React.useState<string>()
  const nameError = projectNameError(projectName)
  const creation = React.useRef<{
    key: string
    runId: string
    target?: { path: string; projectName: string }
    generated?: boolean
    finished?: boolean
  }>(undefined)
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
  const creationKey = JSON.stringify([
    parentPath.trim(),
    projectName.trim(),
    normalizedConfiguration,
  ])
  const projectPath = newProjectPath(parentPath, projectName)
  const location = useNewProjectLocation({
    enabled: input.open && step === "location" && !nameError && !creating,
    path: projectPath,
    pathExists: platform.workspace?.pathExists,
    ownedByCurrentAttempt: ownedTargetKey === creationKey,
  })
  const currentStepIndex = Math.max(steps.indexOf(step), 0)
  const canGoBack = !creating && currentStepIndex > 0
  const canGoNext =
    !creating &&
    nextStepAllowed(step, parentPath, projectName) &&
    (step !== "location" || location.available) &&
    step !== "mode" &&
    (step !== "assistant" || Boolean(planning.proposal))
  const createProjectAvailable = Boolean(
    platform.workspace?.prepareNewProject &&
    platform.engine &&
    modelSelection.currentModel
  )

  const resetPlanning = planning.reset
  const reset = React.useCallback(() => {
    setStepState("location")
    setMode(undefined)
    resetPlanning()
    setParentPath("")
    setProjectName("")
    setCreating(false)
    setError(undefined)
    setLogs([])
    setStatus("idle")
    setConfiguration(defaultNewProjectConfiguration)
    creation.current = undefined
    setOwnedTargetKey(undefined)
  }, [resetPlanning])

  function setStep(next: NewProjectStep) {
    if (creating) return
    if (next !== "assistant") planning.stop()
    setError(undefined)
    setStepState(next)
  }

  function chooseMode(next: NewProjectMode) {
    setMode(next)
    setStep(next === "ai" ? "assistant" : "platform")
  }

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
    updateConfiguration({
      frontend: value,
      uiLibrary: recommendedUiLibrary(value),
    })
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
    if (!canGoNext) return
    if (step === "assistant" && planning.proposal) {
      setConfiguration(planning.proposal)
    }
    const nextStep = steps[currentStepIndex + 1]
    if (nextStep) setStep(nextStep)
  }

  async function createProject() {
    if (nameError || !parentPath.trim()) {
      setStep("location")
      setError(nameError ?? "Choose a location for your project.")
      return
    }
    const workspace = platform.workspace
    if (!workspace?.prepareNewProject) {
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
      if (!platform.engine || !modelSelection.currentModel) {
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
    if (!workspace?.prepareNewProject) return
    setStepState("progress")
    setStatus("preparing")

    const key = creationKey
    if (creation.current?.key !== key) {
      creation.current = { key, runId: crypto.randomUUID() }
      setLogs([])
    }
    const attempt = creation.current
    const runId = attempt.runId
    const unsubscribe = workspace.onProjectCreationEvent?.(runId, (event) => {
      if (
        event.type === "stdout" &&
        event.data.startsWith("Preparing empty project folder:")
      ) {
        setOwnedTargetKey(key)
      }
      if (event.type !== "exit") {
        setLogs((current) => appendProjectCreationLog(current, event))
      }
      setStatus((current) => statusFromProjectCreationEvent(event, current))
    })
    const engine = platform.engine
    // Each generation is its own task: a failed one is not continued.
    const task = `new-project-${crypto.randomUUID()}`
    // The generation agent's work, from its task's records.
    const stopFollowing = engine
      ? followEngineTask(engine, task, (records) => {
          for (const record of records) {
            const log = projectCreationLogFromRecord(record)
            if (log)
              setLogs((current) => appendProjectCreationLog(current, log))
          }
        })
      : undefined

    try {
      const currentModel = modelSelection.currentModel
      const model = engineModelChoice(modelSelection)
      if (
        auth.status !== "authenticated" ||
        !currentModel ||
        !model ||
        !engine
      ) {
        throw new Error("AI model selection is required to create a project.")
      }
      // Each step runs once: a failed installation is retried alone.
      attempt.target ??= await workspace.prepareNewProject({
        parentPath,
        projectName,
        runId,
      })
      const path = attempt.target.path
      setOwnedTargetKey(key)
      if (!attempt.generated) {
        setStatus("generating")
        await engine.call("generateNewProject", {
          task,
          model,
          workspace: { root: path },
          projectName: attempt.target.projectName,
          configuration: normalizedConfiguration,
        })
        attempt.generated = true
        setLogs((current) =>
          appendProjectCreationLog(current, {
            type: "agent",
            channel: "notice",
            data: "New project generation agent finished.\n",
          })
        )
      }
      if (!attempt.finished) {
        await workspace.finishNewProject({
          path,
          configuration: normalizedConfiguration,
          runId,
        })
        attempt.finished = true
      }
      setStatus("verifying")
      setLogs((current) =>
        appendProjectCreationLog(current, {
          type: "agent",
          channel: "notice",
          data: "Initializing generated project for Blame...\n",
        })
      )
      await initializeGeneratedProjectForBlame({
        engine,
        model,
        openGeneratedProject: projects.openGeneratedProject,
        path,
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
      stopFollowing?.()
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
    checkingTarget: location.checking,
    chooseParentPath,
    chooseMode,
    mode,
    planning,
    planningSelection,
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
    nameError,
    parentPath,
    projectName,
    projectPath,
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
    targetError: location.error,
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
  return Boolean(parentPath.trim() && !projectNameError(projectName))
}

function statusFromProjectCreationEvent(
  event: ProjectCreationLog,
  current: ProjectCreationStatus
): ProjectCreationStatus {
  if (event.type === "exit" || event.data === "$ git init\n") return "verifying"
  if (event.data.startsWith("Preparing empty project folder:"))
    return "preparing"
  if (event.data === "Starting AI project generation agent...\n")
    return "generating"
  if (event.data === "Installing project dependencies...\n") return "installing"
  return current
}

/** What the log shows of one record of the generation task. */
export function projectCreationLogFromRecord(
  record: SessionRecord
): ProjectCreationLog | undefined {
  if (record.type === "tool_call_started")
    return { type: "agent", data: `[tool] Running ${record.name}\n` }
  if (record.type === "tool_call_finished" && record.outcome === "failed") {
    const text = record.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim()
    return text
      ? { type: "stderr", data: `${compactEventText(text)}\n` }
      : undefined
  }
  if (record.type !== "assistant_message") return undefined
  const text = record.blocks
    .flatMap((block) =>
      block.type === "text"
        ? [block.text]
        : block.type === "reasoning" && block.text.trim()
          ? [`Planning: ${block.text}`]
          : []
    )
    .join("\n")
    .trim()
  return text
    ? { type: "agent", data: `${compactEventText(text)}\n` }
    : undefined
}

function appendProjectCreationLog(
  current: ProjectCreationLog[],
  next: ProjectCreationLog
) {
  if (!next.channel) return [...current, next]
  const last = current.at(-1)
  if (last?.channel === next.channel) return [...current.slice(0, -1), next]
  if (last?.data === next.data) return current
  return [...current, next]
}

function compactEventText(value: string) {
  return value.replace(/\n{3,}/g, "\n\n")
}

async function initializeGeneratedProjectForBlame(input: {
  engine: Pick<EnginePlatformClient, "call">
  model: EngineModelChoice
  openGeneratedProject: ReturnType<typeof useProjects>["openGeneratedProject"]
  path: string
  appendLog(log: ProjectCreationLog): void
}) {
  let validationFeedback: InitializationFeedback | undefined
  for (
    let attempt = 1;
    attempt <= maxInitializationCompletionAttempts;
    attempt += 1
  ) {
    const initialization = await input.engine.call("initializeProject", {
      model: input.model,
      workspace: { root: input.path },
      validationFeedback,
    })
    try {
      await input.openGeneratedProject(input.path, {
        previewManifest: initialization.previewManifest,
        runConfigurations: initialization.runConfigurations,
      })
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

function refiningInitializationLog(): ProjectCreationLog {
  return {
    type: "agent",
    channel: "notice",
    data: "Refining Blame initialization artifacts...\n",
  }
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
): InitializationFeedback {
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
