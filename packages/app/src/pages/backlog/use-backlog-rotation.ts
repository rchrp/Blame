import * as React from "react"
import { toast } from "sonner"
import type { AgentEvent } from "@blame/agent-runtime"
import type { RuntimeProfileId } from "@blame/preview-runtime"

import type {
  UserStory,
  UserStoryAgentRun,
} from "@/components/backlog/data/backlog-data"
import { userStoryDisplayId } from "@/components/backlog/data/backlog-data"
import { nextCheckpointRunCount } from "@/components/chat/agent-run-checkpoints"
import {
  agentEventText,
  agentFlowUpdate,
} from "@/components/backlog/data/agent-flow"
import { agentPersistenceEvent } from "@/components/backlog/data/agent-stream-coordinator"
import { agentRunFinalization } from "@/components/backlog/data/agent-run-lifecycle"
import { storyWithActiveAgentRun } from "@/components/backlog/data/backlog-store-merge"
import {
  completedClineLog,
  finalAssistantResponse,
} from "@/components/backlog/data/agent-run-recovery"
import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { storyPreviewDevtoolsScope } from "@/components/backlog/shared/preview-devtools-scope"
import { directStoryPreviewScope } from "@/components/backlog/board/project-run-configuration"
import { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import { hostedServiceRequirement } from "@/lib/hosted-service-access"
import type { HostDependencyReport } from "@/context/platform"
import { useRuntimeGate } from "@/pages/backlog/use-runtime-gate"
import { deadAgentRuns } from "@/pages/backlog/agent-run-liveness"
import { pendingTerminalAgentUpdates } from "@/components/backlog/data/agent-terminal-outbox"
import { storiesInTransition } from "@/pages/backlog/story-transitions"
import { useGitIdentity } from "@/context/git-identity"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { createCloudApi } from "@/lib/cloud-api"
import { effectiveProjectCodePractices } from "@/lib/project-code-practice-preferences"
import { storyMaxInputTokens } from "@/components/backlog/data/story-context-limit"
import {
  prepareStartingStoryPreview,
  useStoryPreviewPreparation,
} from "@/pages/backlog/story-preview-preparation"
import {
  notifyDirectFallback,
  storyInitializationGate,
} from "@/pages/backlog/backlog-initialization-gate"
import { type StoryRunMode, useStoryRunMode } from "@/lib/runtime-preference"
import {
  measurePerformanceOperation,
  recordPerformanceCount,
  recordPerformanceEvent,
  recordPerformanceMetric,
} from "@/lib/performance-diagnostics"
import {
  activeAgentRun,
  activePreviewStory,
  clineLogPath,
  clineLogRelativePath,
  errorMessage,
  type HostDependenciesDialogState,
  nextAgentRun,
  notifyCommentResponseCompleted,
  previewRecoveryStateKey,
  queuedStories,
  recoverableAgentRun,
  recoveredMessageCount,
  reportAgentPersistenceError,
  rotationBlocker,
  maxConcurrentDevelopmentStories,
  runningStories,
  staleAgentRunAge,
  storyTelemetryCohorts,
} from "./backlog-rotation-helpers"
import type { StoryAgentStreamControls } from "./use-story-agent-stream"
import {
  activityUpdates,
  agentRunEventUpdate,
  runFlowState,
} from "@/components/backlog/data/user-story-agent-updates"

const blockerRetryDelay = 30_000
const previewRecoveryIntervalMs = 30_000
const agentCompletionRecoveryIntervalMs = 60_000
const interruptedAgentMessage =
  "Agent interrupted while Blame was offline. Resume when ready."
const setupToastId = "backlog-rotation-setup"
const initializationRetryDelay = 5_000

// Starts the Agent Queue's stories; storyStream follows and saves the runs.
export function useBacklogRotation(
  backlog: ReturnType<typeof useBacklogStore>,
  storyStream: StoryAgentStreamControls
) {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const gitIdentity = useGitIdentity()
  const projects = useProjects()
  const selection = useModelSelection({ role: "agent" })
  const premium = auth.license?.licensed === true
  const runMode = useStoryRunMode(premium)
  // Each story runs where it was set to run; older stories without a choice
  // follow the account default.
  const storyRunMode = React.useCallback(
    (story: UserStory): StoryRunMode => story.runMode ?? runMode,
    [runMode]
  )
  const ensureProjectPreviewUrl = platform.workspace?.ensureProjectPreviewUrl
  const startingStoryIds = React.useRef(new Set<string>())
  const blockedStories = React.useRef(new Map<string, number>())
  const reportedBlockers = React.useRef(new Set<string>())
  const agentAuthenticationBlockedUntil = React.useRef(0)
  const previewRecoveryStoryIds = React.useRef(new Set<string>())
  const agentCompletionRecoveryStoryIds = React.useRef(new Set<string>())
  const interruptedAgentRecoveryProjectIds = React.useRef(new Set<string>())
  const interruptedAgentRecoveryStoryIds = React.useRef(new Set<string>())
  const storiesRef = React.useRef(backlog.stories)
  const startStoryRef = React.useRef<(story: UserStory) => Promise<void>>(
    async () => undefined
  )
  const reportBlockerRef = React.useRef<
    (story: UserStory, message: string) => void
  >(() => undefined)
  const recoverCompletedAgentRunsRef = React.useRef<
    (stories: UserStory[]) => void
  >(() => undefined)
  const recoverInterruptedAgentRunsRef = React.useRef<
    (stories: UserStory[]) => void
  >(() => undefined)
  const [hostDependenciesDialog, setHostDependenciesDialog] =
    React.useState<HostDependenciesDialogState>()
  // Bumped to make the queue look again (after a retry delay, when the
  // runtime becomes ready…), even if no story changed.
  const [queueTick, refreshStartingStories] = React.useState(0)
  const runtimeGate = useRuntimeGate({
    onRuntimeReady: () => {
      blockedStories.current.clear()
      refreshStartingStories((value) => value + 1)
    },
    runModeOf: storyRunMode,
    stories: backlog.stories,
  })
  const previewRecoveryState = previewRecoveryStateKey(backlog.stories)
  useStoryPreviewPreparation(backlog)

  React.useEffect(() => {
    storiesRef.current = backlog.stories
  }, [backlog.stories])

  React.useEffect(() => {
    blockedStories.current.clear()
    reportedBlockers.current.clear()
    agentAuthenticationBlockedUntil.current = 0
    previewRecoveryStoryIds.current.clear()
    agentCompletionRecoveryStoryIds.current.clear()
    interruptedAgentRecoveryStoryIds.current.clear()
  }, [projects.activeProject?.id, selection.currentModel?.id])

  // An expired provider token fails every start: the queue waits a while.
  const { onAuthenticationExpired } = storyStream
  React.useEffect(
    () =>
      onAuthenticationExpired(() => {
        agentAuthenticationBlockedUntil.current = Date.now() + blockerRetryDelay
        window.setTimeout(
          () => refreshStartingStories((value) => value + 1),
          blockerRetryDelay
        )
      }),
    [onAuthenticationExpired]
  )

  async function startStory(story: UserStory) {
    if (!projects.activeProject) return
    const detailedStory = await backlog.loadDetail(story)
    const blocker = rotationBlocker(
      auth.status,
      platform,
      selection.currentModel
    )
    if (blocker) return reportBlocker(detailedStory, blocker)

    const projectInitialization = await createCloudApi(
      auth.apiConnection
    ).projectInitialization(projects.activeProject.id)
    const savedInitialization = projectInitialization.initialization
    const gate = storyInitializationGate(
      savedInitialization,
      projects.activeProject.id,
      storyRunMode(detailedStory)
    )
    if (gate === "wait") return retryStory(detailedStory)
    if (gate === "run-direct") return runDirectWithoutInitialization(detailedStory)
    // The agent starts with the saved preview environment; the story's
    // preview waits for it to be checked against the latest commits.
    const initialization =
      savedInitialization?.status === "done" && savedInitialization.previewManifest
        ? { ...savedInitialization, previewManifest: savedInitialization.previewManifest }
        : undefined

    const workspace = platform.workspace
    const agent = platform.agent
    if (!workspace || !agent) return

    const storyMode = storyRunMode(detailedStory)
    const direct = storyMode === "direct"
    const previewProfile: RuntimeProfileId = direct ? "local-container" : storyMode
    if (storyMode === "vercel-compose" && !premium)
      return reportCloudWithoutPremium(detailedStory)

    // Local Container stories wait for the Blame Runtime (or ask for it)
    // instead of failing; the runtime itself is checked by its provider.
    const runtimeDecision = direct ? "go" : runtimeGate.gate(detailedStory)
    if (runtimeDecision === "wait")
      return retryStory(detailedStory, initializationRetryDelay)
    if (runtimeDecision === "needs-runtime")
      return retryStory(detailedStory, blockerRetryDelay)

    const dependencies = await workspace.checkHostDependencies({
      includeRuntime: direct ? false : runtimeGate.hostCheckIncludesRuntime,
      runtimeProfile: previewProfile,
      workspaceMode: direct
        ? "direct"
        : storyMode === "local-container" ? "local-container" : "cloud-mirror",
    })
    if (!dependencies.ok) {
      reportHostDependencyBlocker(
        detailedStory,
        dependencies,
        previewProfile
      )
      return
    }
    // Git won't commit the story's work without a name and an email.
    const identityReady = await gitIdentity?.ensure({
      root: projects.activeProject.path,
      storyTitle: detailedStory.title,
      onSaved: () => retryStory(detailedStory, 0),
    })
    if (identityReady === false) return retryStory(detailedStory, blockerRetryDelay)

    const executionId = crypto.randomUUID()
    const storyId = detailedStory.id
    const telemetryCohorts = storyTelemetryCohorts(
      detailedStory,
      selection.currentModel.id,
      selection.currentModel.provider.id
    )
    const worktree = await workspace.createWorktree({
      branch: detailedStory.branch,
      // Direct runs in the project folder: no new worktree or branch.
      direct,
      executionId,
      repositoryRoot: projects.activeProject.path,
      runtimeProfile: previewProfile,
      storyId,
      storyReference: userStoryDisplayId(detailedStory),
      telemetryCohorts,
      title: detailedStory.title,
    })
    if (!direct)
      prepareStartingStoryPreview(storyId, { executionId, telemetryCohorts, environment: initialization })
    const workingStory = await backlog.update(detailedStory, {
      agentLastEvent: "Worktree ready.",
      baseCommit:
        (
          await workspace.gitLog({
            root: worktree.worktree,
            limit: 1,
            currentBranchOnly: true,
          })
        )[0]?.hash ?? null,
      branch: worktree.branch,
      status: "in-progress",
      workspaceMode: worktree.workspaceMode,
      worktree: worktree.worktree,
    })
    let startedSessionId: string | undefined
    let sessionPromise: ReturnType<typeof agent.sessions.startDevelopment> | undefined
    let started:
      | { run: UserStoryAgentRun; runningStory: UserStory; sessionId: string }
      | undefined
    try {
      sessionPromise = agent.sessions.startDevelopment({
        apiConnection: auth.apiConnection,
        providerId: selection.currentModel.provider.id,
        modelId: selection.currentModel.id,
        credentialLabel: selection.currentModel.credentialLabel,
        reasoningEffort: selection.currentVariant,
        maxInputTokens: storyMaxInputTokens(
          detailedStory.id,
          selection.currentModel,
          selection.allProviders
        ),
        autoSendPrompt: false,
        title: detailedStory.title,
        summary: detailedStory.summary,
        codeSelectionAttachments: detailedStory.codeSelectionAttachments ?? [],
        fileAttachments: detailedStory.fileAttachments ?? [],
        cwd: worktree.worktree,
        workspaceRoot: worktree.worktree,
        workspaceMode: worktree.workspaceMode,
        // In Direct mode, the project's own app (Blame's project runner).
        previewDevtoolsScope: direct
          ? directStoryPreviewScope(
              initialization?.runConfigurations ?? [],
              projects.activeProject.path
            )
          : storyPreviewDevtoolsScope(detailedStory.id),
        codePractices: effectiveProjectCodePractices(
          projectInitialization.practices
        ),
        projectInitialization: initialization && {
          runConfigurationId: detailedStory.runConfigurationId ?? undefined,
          previewManifest: initialization.previewManifest,
          runConfigurations: initialization.runConfigurations,
          databaseMode: initialization.databaseMode,
        },
        executionId,
        projectId: detailedStory.projectId,
        storyId,
      })
      const session = await sessionPromise
      startedSessionId = session.sessionId
      // Stopped, dequeued or discarded while it was starting: let it go.
      if (!storyStillStarting(storyId)) {
        await agent.sessions.abort(session.sessionId).catch(() => undefined)
        return
      }
      const run = await backlog.createAgentRun(detailedStory, {
        checkpointRunCount: nextCheckpointRunCount(detailedStory.agentRuns ?? []),
        clineSessionId: session.sessionId,
        executionId,
        kind: "initial",
        modelId: selection.currentModel.id,
        providerId: selection.currentModel.provider.id,
        reasoningEffort: selection.currentVariant ?? null,
      })
      // The stream keeps this story for when its project is no longer open:
      // with its worktree, and owned by the new run.
      const runningStory = storyWithActiveAgentRun(workingStory, run)
      storyStream.subscribeStoryAgentEvents(
        runningStory,
        run,
        session.sessionId,
        executionId
      )

      await backlog.update(detailedStory, {
        agentModelId: selection.currentModel.id,
        agentProviderId: selection.currentModel.provider.id,
        agentActivities: [],
        agentFinalResponse: null,
        agentUsage: null,
        agentStatus: "Running",
        agentLastError: null,
        agentLastEvent: `Cline debug log: ${clineLogPath(worktree.worktree, session.sessionId)}`,
        clineSessionId: session.sessionId,
      })
      started = { run, runningStory, sessionId: session.sessionId }
    } catch (error) {
      // The story did not start: stop the half-started session and put it
      // back in the queue (its worktree is reused on the next attempt).
      const sessionId =
        startedSessionId ??
        (await sessionPromise?.then((session) => session.sessionId).catch(() => undefined))
      if (sessionId) void agent.sessions.abort(sessionId).catch(() => undefined)
      if (storyStillStarting(storyId)) {
        await backlog
          .update(detailedStory, {
            agentLastError: errorMessage(error),
            agentLastEvent: "Couldn't start the agent; the story is back in the queue.",
            status: "ready",
          })
          .catch(() => undefined)
      }
      throw error
    }
    if (!started) return
    const { run, runningStory, sessionId: startedSession } = started
    const session = { sessionId: startedSession }
    void agent.sessions
      .sendDevelopment({
        executionId,
        sessionId: session.sessionId,
        storyId,
        title: detailedStory.title,
        summary: detailedStory.summary,
        codeSelectionAttachments: detailedStory.codeSelectionAttachments ?? [],
        fileAttachments: detailedStory.fileAttachments ?? [],
      })
      .catch((error) =>
        storyStream.persistAgentEvent(runningStory, run, {
          type: "error",
          sessionId: session.sessionId,
          executionId,
          payload: { message: errorMessage(error) },
        })
      )
      .catch(reportAgentPersistenceError)
  }

  // Up to three agents at a time, whatever their mode. Direct stories share
  // the project folder with each other and with chats, as the Direct mode
  // picker warns; the harness checks each file again when it writes it.
  function storiesToStartNow(readyStories: UserStory[]) {
    const slots =
      maxConcurrentDevelopmentStories -
      runningStories(storiesRef.current) -
      startingStoryIds.current.size
    return readyStories.slice(0, Math.max(0, slots))
  }

  // No usable initialization: run the story Direct rather than wait for one.
  function runDirectWithoutInitialization(story: UserStory) {
    retryStory(story, 0)
    notifyDirectFallback(story.projectId, story.title)
    void backlog
      .update(story, { runMode: "direct" })
      .then(() => {
        blockedStories.current.delete(story.id)
        refreshStartingStories((value) => value + 1)
      })
      .catch(reportAgentPersistenceError)
  }

  // A Cloud Preview story whose owner no longer has Premium: ask where to
  // run it instead of switching silently.
  function reportCloudWithoutPremium(story: UserStory) {
    retryStory(story, blockerRetryDelay)
    const key = `${story.id}:cloud-without-premium`
    if (reportedBlockers.current.has(key)) return
    reportedBlockers.current.add(key)
    const switchTo = (mode: StoryRunMode) => {
      reportedBlockers.current.delete(key)
      void backlog
        .update(story, { runMode: mode })
        .then(() => {
          blockedStories.current.delete(story.id)
          refreshStartingStories((value) => value + 1)
        })
        .catch(reportAgentPersistenceError)
    }
    toast.error(hostedServiceRequirement(auth, "cloud-preview"), {
      action: { label: "Run Direct", onClick: () => switchTo("direct") },
      cancel: { label: "Local Container", onClick: () => switchTo("local-container") },
      description: `${story.title} is waiting. Run it on this computer instead?`,
      duration: Infinity,
      id: `${setupToastId}-${story.id}-cloud`,
      position: "bottom-right",
    })
  }

  // Still the story this start moved to in progress, untouched by the user.
  function storyStillStarting(storyId: string) {
    const current = storiesRef.current.find((story) => story.id === storyId)
    return current?.status === "in-progress" && current.agentStatus !== "Paused"
  }

  function reportBlocker(story: UserStory, message: string) {
    const key = `${story.id}:${message}`
    retryStory(story, blockerRetryDelay)
    // Git asking who you are gets its dialog, not a raw error.
    if (gitIdentity?.handleError(message, () => retryStory(story, 0))) return
    if (reportedBlockers.current.has(key)) return
    reportedBlockers.current.add(key)
    toast.error("User story stayed in Agent Queue", {
      description: message,
      id: `${setupToastId}-${story.id}`,
      position: "bottom-right",
    })
  }

  function reportHostDependencyBlocker(
    story: UserStory,
    report: HostDependencyReport,
    runtimeProfile: RuntimeProfileId
  ) {
    retryStory(story, blockerRetryDelay)
    setHostDependenciesDialog({
      checking: false,
      report,
      runtimeProfile,
      workspaceMode: storyRunMode(story) === "direct"
        ? "direct"
        : runtimeProfile === "local-container" ? "local-container" : "cloud-mirror",
      storyId: story.id,
      storyTitle: story.title,
    })
  }

  async function recheckHostDependencies() {
    const current = hostDependenciesDialog
    if (!current || !platform.workspace?.checkHostDependencies) return
    setHostDependenciesDialog({ ...current, checking: true })
    try {
      const report = await platform.workspace.checkHostDependencies({
        includeRuntime: current.workspaceMode === "direct"
          ? false
          : runtimeGate.hostCheckIncludesRuntime,
        runtimeProfile: current.runtimeProfile,
        workspaceMode: current.workspaceMode,
      })
      if (report.ok) {
        blockedStories.current.delete(current.storyId)
        setHostDependenciesDialog(undefined)
        refreshStartingStories((value) => value + 1)
        return
      }
      setHostDependenciesDialog({ ...current, checking: false, report })
    } catch (error) {
      setHostDependenciesDialog({ ...current, checking: false })
      toast.error("Unable to recheck development requirements", {
        description: errorMessage(error),
        position: "bottom-right",
      })
    }
  }

  function retryStory(story: UserStory, delay = initializationRetryDelay) {
    blockedStories.current.set(story.id, Date.now() + delay)
    window.setTimeout(() => {
      blockedStories.current.delete(story.id)
      refreshStartingStories((value) => value + 1)
    }, delay)
  }

  const persistRecoveredPreviewUrl = React.useCallback(
    async (story: UserStory, previewUrl: string | null) => {
      if (!previewUrl || previewUrl === story.previewUrl) return
      await backlog.update(story, { previewUrl })
    },
    [backlog]
  )

  const recoverActivePreviews = React.useCallback(
    (stories: UserStory[]) => {
      if (!ensureProjectPreviewUrl) return
      stories.filter(activePreviewStory).forEach((story) => {
        if (!story.worktree || previewRecoveryStoryIds.current.has(story.id))
          return
        previewRecoveryStoryIds.current.add(story.id)
        void ensureProjectPreviewUrl({
          executionId: crypto.randomUUID(),
          storyId: story.id,
          telemetryCohorts: storyTelemetryCohorts(
            story,
            story.agentModelId,
            story.agentProviderId
          ),
          workspaceMode:
            story.workspaceMode ??
            (storyRunMode(story) === "vercel-compose"
              ? "cloud-mirror"
              : "local-container"),
          worktree: story.worktree,
        })
          .then((previewUrl) => persistRecoveredPreviewUrl(story, previewUrl))
          .catch(() => undefined)
          .finally(() => previewRecoveryStoryIds.current.delete(story.id))
      })
    },
    [
      ensureProjectPreviewUrl,
      persistRecoveredPreviewUrl,
      storyRunMode,
    ]
  )

  React.useEffect(() => {
    if (!ensureProjectPreviewUrl || backlog.loading) return
    recoverActivePreviews(storiesRef.current)
    const timer = window.setInterval(
      () => recoverActivePreviews(storiesRef.current),
      previewRecoveryIntervalMs
    )
    return () => window.clearInterval(timer)
  }, [
    backlog.loading,
    ensureProjectPreviewUrl,
    previewRecoveryState,
    recoverActivePreviews,
  ])

  function recoverCompletedAgentRuns(stories: UserStory[]) {
    recordPerformanceCount("agent.recovery.poll")
    recordPerformanceMetric("agent.recovery.story_count", stories.length)
    stories.forEach((story) => {
      const run = recoverableAgentRun(story)
      if (!run || agentCompletionRecoveryStoryIds.current.has(story.id)) return
      recordPerformanceCount("agent.recovery.candidate")
      recordPerformanceEvent("agent.recovery.started", {
        runAgeMs: staleAgentRunAge(run),
      })
      agentCompletionRecoveryStoryIds.current.add(story.id)
      void recoverCompletedAgentRun(story, run).finally(() =>
        agentCompletionRecoveryStoryIds.current.delete(story.id)
      )
    })
  }

  function recoverInterruptedAgentRuns(stories: UserStory[]) {
    const recover = (story: UserStory, run: UserStoryAgentRun) => {
      if (interruptedAgentRecoveryStoryIds.current.has(story.id)) return
      interruptedAgentRecoveryStoryIds.current.add(story.id)
      void recoverInterruptedAgentRun(story, run)
        .catch(reportAgentPersistenceError)
        .finally(() =>
          interruptedAgentRecoveryStoryIds.current.delete(story.id)
        )
    }
    const live = platform.agent?.sessions.live
    if (!live) {
      // Older desktop builds cannot tell: fall back to the idle heuristic.
      stories.forEach((story) => {
        const run = recoverableAgentRun(story)
        if (run) recover(story, run)
      })
      return
    }
    // Ask the desktop which sessions still run: dead ones are recovered at
    // once, live ones are never touched however quiet they are.
    const skip = new Set([
      ...startingStoryIds.current,
      ...interruptedAgentRecoveryStoryIds.current,
      ...storiesInTransition(),
    ])
    void deadAgentRuns(stories, live, { skip })
      .then((dead) => dead.forEach(({ run, story }) => recover(story, run)))
      .catch(reportAgentPersistenceError)
  }

  async function recoverInterruptedAgentRun(
    story: UserStory,
    run: UserStoryAgentRun
  ) {
    // A finished run whose result is still waiting to be saved: let the
    // outbox replay it instead of calling it interrupted.
    const savedLocally = pendingTerminalAgentUpdates(
      window.localStorage,
      story.projectId
    ).some((update) => update.runId === run.id)
    if (savedLocally) return
    if (await recoverCompletedAgentRun(story, run)) return
    const currentStory = await backlog.loadDetail(story)
    const currentRun = activeAgentRun(currentStory, run) ?? run
    const completedAt = new Date().toISOString()
    const event = {
      createdAt: completedAt,
      payload: {},
      type: "error",
    } as const
    await backlog.finalizeAgentRun(currentStory, currentRun, {
      activities: [],
      agentLastError: interruptedAgentMessage,
      agentLastEvent: interruptedAgentMessage,
      completedAt,
      finalResponse: interruptedAgentMessage,
      outcome: "paused",
      persistenceEvent: recoveryPersistenceEvent(
        currentStory,
        currentRun,
        event
      ),
      status: "failed",
    })
  }

  async function recoverCompletedAgentRun(
    story: UserStory,
    run: UserStoryAgentRun
  ) {
    return measurePerformanceOperation("agent.recovery.total", async () => {
      return inspectCompletedAgentRun(story, run)
    })
  }

  async function inspectCompletedAgentRun(
    story: UserStory,
    run: UserStoryAgentRun
  ) {
    const log = await clineLog(story, run)
    const nextRun = nextAgentRun(story, run)
    if (
      !completedClineLog(log, run.createdAt, nextRun?.createdAt) &&
      !nextRun
    ) {
      recordPerformanceCount("agent.recovery.incomplete")
      recordPerformanceEvent("agent.recovery.incomplete", {
        logBytes: log.length,
      })
      return false
    }
    const currentStory = await measurePerformanceOperation(
      "agent.recovery.detail",
      () => backlog.loadDetail(story)
    )
    const currentRun = activeAgentRun(currentStory, run) ?? run
    if (currentRun.status !== "running") {
      recordPerformanceCount("agent.recovery.already_terminal")
      return true
    }
    const response = await recoveredFinalResponse(currentStory, currentRun)
    const event: AgentEvent = {
      payload: response ? { text: response } : {},
      type: "done",
    }
    const flowUpdate = agentFlowUpdate(runFlowState(currentRun), event)
    const text = agentEventText(event)
    const storyInput = {
      ...flowUpdate,
      agentLastError: null,
      agentLastEvent: "Agent completed. Ready for review.",
      agentStatus: null,
      status: "in-review" as const,
    }
    const finalization = agentRunFinalization(
      activityUpdates(storyInput),
      storyInput,
      {
        ...agentRunEventUpdate(flowUpdate, event, text),
        persistenceEvent: recoveryPersistenceEvent(
          currentStory,
          currentRun,
          event
        ),
      }
    )
    if (!finalization) return false
    await backlog.finalizeAgentRun(currentStory, currentRun, finalization)
    notifyCommentResponseCompleted(currentStory, currentRun, platform)
    recordPerformanceCount("agent.recovery.completed")
    return true
  }

  function recoveryPersistenceEvent(
    story: UserStory,
    run: UserStoryAgentRun,
    event: AgentEvent
  ) {
    return agentPersistenceEvent(event, {
      executionId: run.executionId ?? event.executionId ?? run.id,
      lastSequenceNumber: run.lastSequenceNumber,
      runId: run.id,
      sessionId:
        event.sessionId ?? run.clineSessionId ?? story.clineSessionId ?? run.id,
    })
  }

  async function recoveredFinalResponse(
    story: UserStory,
    run: UserStoryAgentRun
  ) {
    const sessionId = run.clineSessionId ?? story.clineSessionId
    if (!sessionId || !platform.agent) return undefined
    const messages = await measurePerformanceOperation(
      "agent.recovery.messages",
      () => platform.agent!.sessions.messages(sessionId)
    ).catch(() => undefined)
    recordPerformanceMetric(
      "agent.recovery.message_count",
      recoveredMessageCount(messages)
    )
    return finalAssistantResponse(
      messages,
      run.createdAt,
      nextAgentRun(story, run)?.createdAt
    )
  }

  async function clineLog(story: UserStory, run: UserStoryAgentRun) {
    const workspace = platform.workspace
    const sessionId = run.clineSessionId ?? story.clineSessionId
    if (!workspace || !story.worktree || !sessionId) return ""
    const log = await measurePerformanceOperation("agent.recovery.log", () =>
      workspace.readFile({
        root: story.worktree!,
        path: clineLogRelativePath(sessionId),
      })
    ).catch(() => "")
    recordPerformanceMetric("agent.recovery.log_bytes", log.length)
    return log
  }

  React.useEffect(() => {
    recoverCompletedAgentRunsRef.current = recoverCompletedAgentRuns
    recoverInterruptedAgentRunsRef.current = recoverInterruptedAgentRuns
  })

  React.useEffect(() => {
    if (!platform.workspace || backlog.loading) return
    const projectId = backlog.projectId
    if (!projectId || interruptedAgentRecoveryProjectIds.current.has(projectId))
      return
    interruptedAgentRecoveryProjectIds.current.add(projectId)
    recoverInterruptedAgentRunsRef.current(storiesRef.current)
  }, [backlog.loading, backlog.projectId, platform.workspace])

  React.useEffect(() => {
    if (!platform.workspace || backlog.loading) return
    const timer = window.setInterval(() => {
      recoverCompletedAgentRunsRef.current(storiesRef.current)
      // A session can die at any time (worker crash): keep checking.
      if (platform.agent?.sessions.live)
        recoverInterruptedAgentRunsRef.current(storiesRef.current)
    }, agentCompletionRecoveryIntervalMs)
    return () => window.clearInterval(timer)
  }, [backlog.loading, platform.agent, platform.workspace])

  const storiesToStartRef = React.useRef(storiesToStartNow)
  React.useEffect(() => {
    startStoryRef.current = startStory
    reportBlockerRef.current = reportBlocker
    storiesToStartRef.current = storiesToStartNow
  })

  React.useEffect(() => {
    if (!projects.activeProject || auth.status !== "authenticated") return
    if (backlog.loading || !backlog.projectId) return
    if (agentAuthenticationBlockedUntil.current > Date.now()) return

    const readyStories = queuedStories(
      backlog.stories,
      startingStoryIds.current,
      blockedStories.current
    )
    if (readyStories.length === 0) return

    const storiesToStart = storiesToStartRef.current(readyStories)
    if (!storiesToStart.length) return
    storiesToStart.forEach((story) => {
      startingStoryIds.current.add(story.id)
      void startStoryRef
        .current(story)
        .catch((error) => reportBlockerRef.current(story, errorMessage(error)))
        .finally(() => {
          startingStoryIds.current.delete(story.id)
          refreshStartingStories((value) => value + 1)
        })
    })
    refreshStartingStories((value) => value + 1)
  }, [
    auth.status,
    backlog.loading,
    backlog.projectId,
    backlog.stories,
    projects.activeProject,
    queueTick,
    storyRunMode,
  ])

  return {
    runtimeWaitingLabel: runtimeGate.waitingLabel,
    hostDependenciesDialog: {
      checking: Boolean(hostDependenciesDialog?.checking),
      onOpenChange(open: boolean) {
        if (!open) setHostDependenciesDialog(undefined)
      },
      onRecheck: recheckHostDependencies,
      open: Boolean(hostDependenciesDialog),
      report: hostDependenciesDialog?.report,
      storyTitle: hostDependenciesDialog?.storyTitle,
    },
  }
}
