import * as React from "react"
import { toast } from "sonner"

import {
  type ModelSelection,
  useModelSelection,
} from "@/components/model/model-selection"
import type { ProjectInitializationDatabaseMode } from "@blame/agent-runtime"
import { Button } from "@/components/ui/button"
import { HostDependenciesDialog } from "@/pages/backlog/host-dependencies-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useCloudAuth } from "@/context/cloud-auth"
import {
  usePlatform,
  type HostDependencyReport,
  type WorkspaceClient,
} from "@/context/platform"
import { useProjects } from "@/context/projects"
import { CloudApiError, createCloudApi } from "@/lib/cloud-api"
import { navigate } from "@/components/navigation/navigation"
import { ProgressNotificationBody } from "@/components/shared/progress-notification"
import {
  notifyProjectInitializationUpdated,
  requestProjectInitializationCancel,
  requestProjectInitializationRun,
  subscribeProjectInitializationCancelRequested,
  subscribeProjectInitializationRunRequested,
} from "@/components/project-initialization/project-initialization-events"
import { blockedInitialization } from "@/components/project-initialization/initialization-blocked"
import {
  DatabaseModeOptions,
  databaseEvidenceSentence,
} from "@/components/project-initialization/database-mode-options"
import { readableInitializationError } from "@/pages/initialization/initialization-setup-draft"
import {
  initializationStartsAutomatically,
  initializationRunningHere,
  markInitializationRunning,
} from "@/components/project-initialization/project-initialization-availability"
import {
  agentInitializationProgress,
  initializationProgressChannel,
  initializationProgressFor,
  setInitializationProgress,
} from "@/components/project-initialization/project-initialization-progress"

const toastId = "project-initialization"
const maxBackendCompletionAttempts = 3

type InitializationAuth = Pick<
  ReturnType<typeof useCloudAuth>,
  "apiConnection" | "status"
>

type InitializationRunInput = {
  project: { id: string; name: string; path: string }
  auth: InitializationAuth
  agent: NonNullable<ReturnType<typeof usePlatform>["agent"]>
  providerId: string
  modelId: string
  credentialLabel?: string
  reasoningEffort?: ModelSelection["currentVariant"]
  preferences?: {
    database?: {
      mode: ProjectInitializationDatabaseMode
    }
  }
  /** What showed the project uses a database, for the dialog. */
  databaseEvidence?: string[]
  /** The project commit the analysis starts from. */
  checkedCommit?: string
}

type InitializationValidationFeedback = {
  validationError: string
  previousResult: string
}

type InitializationAgentResult = Awaited<
  ReturnType<InitializationRunInput["agent"]["initializations"]["run"]>
>

type OpenHostDependenciesDialog = (
  run: InitializationRunInput,
  report: HostDependencyReport
) => void

// The run this app has in progress for a project, so Cancel can stop it.
type ActiveInitializationRun = {
  project: InitializationRunInput["project"]
  agent: InitializationRunInput["agent"]
  /** The channel of the run's progress: the agent runtime cancels the run by it. */
  progressId: string
  /** The person cancelled it: it saves nothing and starts no other agent run. */
  cancelled: boolean
  /** The agent runtime stopped the analysis after the cancellation. */
  agentStopped: boolean
}

const activeRuns = new Map<string, ActiveInitializationRun>()

export function ProjectInitializationRunner() {
  const controller = useProjectInitializationController()
  return (
    <>
      <InitializationDatabaseDialog controller={controller} />
      <HostDependenciesDialog {...controller.hostDependenciesDialog} />
    </>
  )
}

function useProjectInitializationController() {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const projects = useProjects()
  const selection = useModelSelection({ role: "alternative" })
  const activeProject = projects.activeProject
  const currentModel = selection.currentModel
  const initializationAuth = React.useMemo(
    () => ({ apiConnection: auth.apiConnection, status: auth.status }),
    [auth.apiConnection, auth.status]
  )
  const databaseDialog = useDatabaseDialogState()
  const hostDependenciesDialog = useHostDependenciesDialogState(
    platform.workspace,
    databaseDialog.openDatabaseDialog
  )

  useInitializationEffect(
    activeProject,
    platform.agent,
    platform.workspace,
    initializationAuth,
    currentModel,
    selection.currentVariant,
    databaseDialog.openDatabaseDialog,
    hostDependenciesDialog.openHostDependenciesDialog
  )
  useInitializationRunRequests({
    activeProject,
    agent: platform.agent,
    workspace: platform.workspace,
    auth: initializationAuth,
    currentModel,
    currentVariant: selection.currentVariant,
    openDatabaseDialog: databaseDialog.openDatabaseDialog,
    openHostDependenciesDialog:
      hostDependenciesDialog.openHostDependenciesDialog,
  })
  React.useEffect(
    () => subscribeProjectInitializationCancelRequested(cancelInitialization),
    []
  )

  return initializationController({
    databaseDialog,
    hostDependenciesDialog,
    removeRecentProject: projects.removeRecentProject,
  })
}

function initializationController(input: {
  databaseDialog: ReturnType<typeof useDatabaseDialogState>
  hostDependenciesDialog: ReturnType<typeof useHostDependenciesDialogState>
  removeRecentProject: (path: string) => void
}) {
  const cancelDatabaseChoice = () => {
    const project = input.databaseDialog.pendingRun?.project
    input.databaseDialog.setOpen(false)
    if (project) input.removeRecentProject(project.path)
  }

  return {
    databaseDialogOpen: input.databaseDialog.open,
    databaseEvidence: input.databaseDialog.pendingRun?.databaseEvidence,
    hostDependenciesDialog: input.hostDependenciesDialog.dialog,
    cancelDatabaseChoice,
    selectDatabaseMode: input.databaseDialog.selectDatabaseMode,
    setDatabaseDialogOpen: (open: boolean) => {
      if (!open) cancelDatabaseChoice()
    },
  }
}

function useDatabaseDialogState() {
  const [pendingRun, setPendingRun] = React.useState<InitializationRunInput>()
  const openDatabaseDialog = React.useCallback(
    (run: InitializationRunInput) => {
      setPendingRun(run)
    },
    []
  )
  const setOpen = React.useCallback((open: boolean) => {
    if (!open) setPendingRun(undefined)
  }, [])
  const selectDatabaseMode = React.useCallback(
    (mode: ProjectInitializationDatabaseMode) => {
      const run = pendingRun
      if (!run) return
      setPendingRun(undefined)
      void runInitialization({
        ...run,
        preferences: {
          ...run.preferences,
          database: { mode },
        },
      })
    },
    [pendingRun]
  )

  return {
    open: Boolean(pendingRun),
    openDatabaseDialog,
    pendingRun,
    selectDatabaseMode,
    setOpen,
  }
}

function useHostDependenciesDialogState(
  workspace: WorkspaceClient | undefined,
  openDatabaseDialog: (run: InitializationRunInput) => void
) {
  const [pendingRun, setPendingRun] = React.useState<InitializationRunInput>()
  const [report, setReport] = React.useState<HostDependencyReport>()
  const [checking, setChecking] = React.useState(false)

  const openHostDependenciesDialog = React.useCallback(
    (run: InitializationRunInput, nextReport: HostDependencyReport) => {
      setPendingRun(run)
      setReport(nextReport)
      setChecking(false)
    },
    []
  )

  async function recheck() {
    if (!workspace || !pendingRun) return
    setChecking(true)
    try {
      const nextReport = await checkInitializationHostDependencies(workspace)
      if (!nextReport.ok) {
        setReport(nextReport)
        return
      }
      const run = pendingRun
      setPendingRun(undefined)
      setReport(undefined)
      await startInitialization(run, workspace, openDatabaseDialog, undefined)
    } finally {
      setChecking(false)
    }
  }

  return {
    dialog: {
      checking,
      onOpenChange(open: boolean) {
        if (!open) {
          setPendingRun(undefined)
          setReport(undefined)
        }
      },
      onRecheck: recheck,
      open: Boolean(pendingRun),
      report,
    },
    openHostDependenciesDialog,
  }
}

function InitializationDatabaseDialog({
  controller,
}: {
  controller: ReturnType<typeof useProjectInitializationController>
}) {
  return (
    <Dialog
      open={controller.databaseDialogOpen}
      onOpenChange={controller.setDatabaseDialogOpen}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Database for this project's previews</DialogTitle>
          <DialogDescription>
            {databaseEvidenceSentence(controller.databaseEvidence)} You can
            change this later on the Preview Environment page.
          </DialogDescription>
        </DialogHeader>
        <DatabaseModeOptions onSelect={controller.selectDatabaseMode} />
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={controller.cancelDatabaseChoice}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function useInitializationEffect(
  activeProject: { id: string; name: string; path: string } | undefined,
  agent: NonNullable<ReturnType<typeof usePlatform>["agent"]> | undefined,
  workspace: WorkspaceClient | undefined,
  auth: InitializationAuth,
  currentModel: ModelSelection["currentModel"],
  currentVariant: ModelSelection["currentVariant"],
  openDatabaseDialog: (run: InitializationRunInput) => void,
  openHostDependenciesDialog: OpenHostDependenciesDialog | undefined
) {
  React.useEffect(
    () =>
      initializationEffect({
        activeProject,
        agent,
        workspace,
        auth,
        currentModel,
        currentVariant,
        openDatabaseDialog,
        openHostDependenciesDialog,
      }),
    [
      activeProject,
      agent,
      workspace,
      auth,
      currentModel,
      currentVariant,
      openDatabaseDialog,
      openHostDependenciesDialog,
    ]
  )
}

// "Run again" from the toast or the Initialization page.
function useInitializationRunRequests(
  input: Parameters<typeof initializationEffect>[0]
) {
  // An effect event reads the latest input without resubscribing.
  const onRunRequested = React.useEffectEvent<
    Parameters<typeof subscribeProjectInitializationRunRequested>[0]
  >((projectId, options) => {
    if (input.activeProject?.id !== projectId) return
    if (initializationRunningHere(projectId)) return
    const run = runInput(
      input.activeProject,
      input.auth,
      input.agent,
      input.currentModel,
      input.currentVariant
    )
    if (!run) {
      toast.error("The analysis needs a model", {
        description: "Choose a model in Settings, then run it again.",
        id: toastId,
        position: "bottom-right",
      })
      return
    }
    void startInitialization(
      options.databaseMode
        ? {
            ...run,
            preferences: { database: { mode: options.databaseMode } },
          }
        : run,
      input.workspace,
      input.openDatabaseDialog,
      input.openHostDependenciesDialog
    )
  })
  React.useEffect(
    () => subscribeProjectInitializationRunRequested(onRunRequested),
    []
  )
}

function initializationEffect(input: {
  activeProject?: { id: string; name: string; path: string }
  agent?: NonNullable<ReturnType<typeof usePlatform>["agent"]>
  workspace?: WorkspaceClient
  auth: InitializationAuth
  currentModel: ModelSelection["currentModel"]
  currentVariant: ModelSelection["currentVariant"]
  openDatabaseDialog: (run: InitializationRunInput) => void
  openHostDependenciesDialog: OpenHostDependenciesDialog | undefined
}) {
  if (!input.activeProject || input.auth.status !== "authenticated") return
  if (!input.agent) return
  const controller = new AbortController()
  void maybeInitializeProject(input, controller.signal)
  return () => controller.abort()
}

async function maybeInitializeProject(
  input: Parameters<typeof initializationEffect>[0],
  signal: AbortSignal
) {
  if (!input.activeProject || !input.agent) return
  const cloud = createCloudApi(input.auth.apiConnection)
  const snapshot = await cloud.projectInitialization(input.activeProject.id)
  if (
    signal.aborted ||
    !initializationStartsAutomatically(snapshot.initialization, {
      runningHere: initializationRunningHere(input.activeProject.id),
    })
  )
    return
  const run = runInput(
    input.activeProject,
    input.auth,
    input.agent,
    input.currentModel,
    input.currentVariant
  )
  if (!run) return
  await startInitialization(
    run,
    input.workspace,
    input.openDatabaseDialog,
    input.openHostDependenciesDialog
  )
}

function runInput(
  project: InitializationRunInput["project"] | undefined,
  auth: InitializationAuth,
  agent: InitializationRunInput["agent"] | undefined,
  model: ModelSelection["currentModel"],
  variant: ModelSelection["currentVariant"]
): InitializationRunInput | undefined {
  if (!project || !model || auth.status !== "authenticated" || !agent) return
  return {
    project,
    auth,
    agent,
    providerId: model.provider.id,
    modelId: model.id,
    credentialLabel: model.credentialLabel,
    reasoningEffort: variant,
  }
}

async function runInitialization(input: InitializationRunInput) {
  const projectId = input.project.id
  if (initializationRunningHere(projectId)) return
  const cloud = createCloudApi(input.auth.apiConnection)
  const run: ActiveInitializationRun = {
    project: input.project,
    agent: input.agent,
    progressId: crypto.randomUUID(),
    cancelled: false,
    agentStopped: false,
  }
  const progress = (update: {
    percent: number
    label: string
    detail?: string
  }) => {
    // A cancelled run says it is stopping until it ends.
    if (run.cancelled) return
    setInitializationProgress(projectId, update)
    showProgress(input.project.name, projectId)
  }
  const stopFollowing = input.agent.sessions.onEvent(
    initializationProgressChannel(run.progressId),
    (event) => {
      // The agent runtime knows the run once it reports on it: a
      // cancellation sent before then reaches it now.
      if (run.cancelled) void stopAgentRun(run)
      const update = agentInitializationProgress(event)
      if (update) progress(update)
    }
  )
  activeRuns.set(projectId, run)
  markInitializationRunning(projectId, true)
  progress({ percent: 2, label: "Starting the analysis" })
  try {
    await persistInitializationResult(input, cloud, run, progress)
  } catch (error) {
    if (run.cancelled) await persistInitializationCancellation(input, cloud)
    else await persistInitializationError(input, cloud, error)
  } finally {
    stopFollowing()
    activeRuns.delete(projectId)
    setInitializationProgress(projectId, undefined)
    markInitializationRunning(projectId, false)
  }
}

// Cancel, from the toast or the Initialization page.
function cancelInitialization(projectId: string) {
  const run = activeRuns.get(projectId)
  if (!run || run.cancelled) return
  setInitializationProgress(projectId, {
    percent: initializationProgressFor(projectId)?.percent ?? 0,
    label: "Cancelling the analysis",
    cancelling: true,
  })
  run.cancelled = true
  showProgress(run.project.name, projectId)
  void stopAgentRun(run)
}

// False until the agent runtime runs the analysis: the next progress
// notice of the run sends the cancellation again.
async function stopAgentRun(run: ActiveInitializationRun) {
  if (run.agentStopped) return
  run.agentStopped = await run.agent.initializations
    .cancel(run.progressId)
    .catch(() => false)
}

function assertNotCancelled(run: ActiveInitializationRun) {
  if (run.cancelled) throw new Error("Project initialization cancelled")
}

function showProgress(projectName: string, projectId: string) {
  const current = initializationProgressFor(projectId)
  if (!current) return
  toast.loading(`Setting up the ${projectName} environment`, {
    id: toastId,
    position: "bottom-right",
    duration: Infinity,
    className: "progress-notification-toast",
    closeButton: false,
    dismissible: true,
    action: current.cancelling
      ? undefined
      : {
          label: "Cancel",
          onClick: (event) => {
            // The toast stays: it says the analysis is stopping.
            event.preventDefault()
            requestProjectInitializationCancel(projectId)
          },
        },
    description: (
      <ProgressNotificationBody
        label={current.label}
        percent={current.percent}
        detail={current.detail}
      />
    ),
  })
}

async function startInitialization(
  run: InitializationRunInput,
  workspace: WorkspaceClient | undefined,
  openDatabaseDialog: (run: InitializationRunInput) => void,
  openHostDependenciesDialog: OpenHostDependenciesDialog | undefined
) {
  const input = { ...run, checkedCommit: await headCommit(run, workspace) }
  const report = workspace
    ? await checkInitializationHostDependencies(workspace)
    : undefined
  if (report && !report.ok) {
    openHostDependenciesDialog?.(input, report)
    return
  }
  if (!input.preferences?.database) {
    const evidence = await projectDatabaseEvidence(input.project, workspace)
    if (evidence.length) {
      openDatabaseDialog({ ...input, databaseEvidence: evidence })
      return
    }
  }
  await runInitialization(input)
}

// The preview environment counts as checked against it.
async function headCommit(
  input: InitializationRunInput,
  workspace: WorkspaceClient | undefined
) {
  if (!workspace) return undefined
  const history = await workspace
    .gitLog({ root: input.project.path, limit: 1, currentBranchOnly: true })
    .catch(() => [])
  return history[0]?.hash
}

function checkInitializationHostDependencies(workspace: WorkspaceClient) {
  return workspace.checkHostDependencies({ includeRuntime: false })
}

async function persistInitializationResult(
  input: InitializationRunInput,
  cloud: ReturnType<typeof createCloudApi>,
  run: ActiveInitializationRun,
  progress: (update: {
    percent: number
    label: string
    detail?: string
  }) => void
) {
  await cloud.startProjectInitialization(input.project.id, {
    providerId: input.providerId,
    modelId: input.modelId,
  })
  notifyProjectInitializationUpdated(input.project.id)
  let feedback: InitializationValidationFeedback | undefined
  for (let attempt = 1; attempt <= maxBackendCompletionAttempts; attempt += 1) {
    assertNotCancelled(run)
    const result = await runProjectInitializationAgent(
      input,
      run.progressId,
      feedback
    )
    // A setup the agent submitted as the person cancelled is not saved.
    assertNotCancelled(run)
    progress({ percent: 95, label: "Saving the setup" })
    try {
      await completeProjectInitialization(input, cloud, result)
      showSuccess(result.previewManifest.risks.length)
      return
    } catch (error) {
      if (!shouldRetryBackendValidation(error, attempt)) throw error
      feedback = validationFeedback(error, result)
      progress({
        percent: 60,
        label: "Fixing the setup",
        detail: errorMessage(error),
      })
    }
  }
}

function runProjectInitializationAgent(
  input: InitializationRunInput,
  progressId: string,
  validationFeedback?: InitializationValidationFeedback
) {
  return input.agent.initializations.run({
    progressId,
    apiConnection: input.auth.apiConnection,
    providerId: input.providerId,
    modelId: input.modelId,
    credentialLabel: input.credentialLabel,
    reasoningEffort: input.reasoningEffort,
    cwd: input.project.path,
    workspaceRoot: input.project.path,
    preferences: input.preferences,
    validationFeedback,
  })
}

async function completeProjectInitialization(
  input: InitializationRunInput,
  cloud: ReturnType<typeof createCloudApi>,
  result: InitializationAgentResult
) {
  await cloud.completeProjectInitialization(input.project.id, {
    clineSessionId: result.sessionId,
    previewManifest: result.previewManifest,
    runConfigurations: result.runConfigurations,
    databaseMode: input.preferences?.database?.mode ?? null,
    checkedCommit: input.checkedCommit ?? null,
  })
  notifyProjectInitializationUpdated(input.project.id)
}

function shouldRetryBackendValidation(error: unknown, attempt: number) {
  return (
    attempt < maxBackendCompletionAttempts && isBackendValidationError(error)
  )
}

function isBackendValidationError(error: unknown) {
  return error instanceof CloudApiError && [400, 422].includes(error.status)
}

function validationFeedback(
  error: unknown,
  result: InitializationAgentResult
): InitializationValidationFeedback {
  return {
    validationError: errorMessage(error),
    previousResult: JSON.stringify({
      previewManifest: result.previewManifest,
      runConfigurations: result.runConfigurations,
    }),
  }
}

// What shows the project uses a database: the desktop scans the whole
// project (dependencies, env keys, Compose services, migrations); elsewhere
// a few well-known files are read.
async function projectDatabaseEvidence(
  project: InitializationRunInput["project"],
  workspace: WorkspaceClient | undefined
) {
  if (!workspace) return []
  if (workspace.databaseEvidence) {
    try {
      return (await workspace.databaseEvidence({ root: project.path })).evidence
    } catch {
      // Read the well-known files instead.
    }
  }
  const files = await Promise.all(
    databaseDetectionFiles.map((path) =>
      readWorkspaceFile(workspace, project.path, path)
    )
  )
  return files.some((content) => databaseContentPattern.test(content))
    ? ["database settings in the project's files"]
    : []
}

async function readWorkspaceFile(
  workspace: WorkspaceClient,
  root: string,
  path: string
) {
  try {
    return await workspace.readFile({ root, path })
  } catch {
    return ""
  }
}

const databaseDetectionFiles = [
  ".env",
  ".env.example",
  ".env.local",
  "package.json",
  "prisma/schema.prisma",
  "drizzle.config.ts",
  "drizzle.config.js",
  "apps/api/.env",
  "apps/api/.env.example",
  "apps/api/package.json",
  "apps/api/config/database.ts",
  "apps/api/start/env.ts",
  "apps/backend/.env",
  "apps/backend/.env.example",
  "apps/backend/package.json",
  "apps/backend/config/database.ts",
  "apps/backend/start/env.ts",
]

const databaseContentPattern =
  /\b(?:DATABASE_URL|DB_HOST|DB_DATABASE|MYSQL_|POSTGRES_|MONGODB_URI|@adonisjs\/lucid|prisma|drizzle-orm|typeorm|sequelize|mongoose|knex|mysql2|pg)\b/i

async function persistInitializationError(
  input: InitializationRunInput,
  cloud: ReturnType<typeof createCloudApi>,
  error: unknown
) {
  await cloud
    .failProjectInitialization(input.project.id, { error: errorMessage(error) })
    .catch(() => undefined)
  notifyProjectInitializationUpdated(input.project.id)
  showError(input.project.id, error)
}

async function persistInitializationCancellation(
  input: InitializationRunInput,
  cloud: ReturnType<typeof createCloudApi>
) {
  await cloud
    .cancelProjectInitialization(input.project.id)
    .catch(() => undefined)
  notifyProjectInitializationUpdated(input.project.id)
  showCancelled(input)
}

function showCancelled(input: InitializationRunInput) {
  toast.info("Preview environment setup cancelled", {
    description: "Stories run in Direct mode until you run the setup again.",
    id: toastId,
    position: "bottom-right",
    duration: 10_000,
    className: undefined,
    action: {
      label: "Run again",
      onClick: () =>
        requestProjectInitializationRun(input.project.id, {
          databaseMode: input.preferences?.database?.mode,
        }),
    },
  })
}

function showError(projectId: string, error: unknown) {
  const blocked = blockedInitialization(errorMessage(error))
  if (blocked) {
    toast.warning(blocked.title, {
      description: `${blocked.summary} ${blocked.userAction}`,
      id: toastId,
      position: "bottom-right",
      duration: 30_000,
      className: undefined,
      action: { label: "Details", onClick: () => navigate("/initialization") },
    })
    return
  }
  toast.error("Preview environment setup failed", {
    description: `${readableInitializationError(errorMessage(error))} Stories run in Direct mode until it works.`,
    id: toastId,
    position: "bottom-right",
    duration: 20_000,
    className: undefined,
    action: {
      label: "Run again",
      onClick: () => requestProjectInitializationRun(projectId),
    },
    cancel: { label: "Details", onClick: () => navigate("/initialization") },
  })
}

function showSuccess(warnings: number) {
  if (warnings) {
    toast.warning("Preview environment ready, with warnings", {
      description: `Blame saved the setup, but ${warnings === 1 ? "one point needs" : `${warnings} points need`} a look.`,
      id: toastId,
      position: "bottom-right",
      duration: 15_000,
      action: { label: "Review", onClick: () => navigate("/initialization") },
    })
    return
  }
  toast.success("Preview environment ready", {
    description: "Stories can now run in containers with a live preview.",
    id: toastId,
    position: "bottom-right",
    duration: 6_000,
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Unable to set up the preview environment"
}
