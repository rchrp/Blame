import * as React from "react"
import { toast } from "sonner"
import type { AgentEvent } from "@blame/agent-runtime"
import type { RuntimeProfileId } from "@blame/preview-runtime"

import type {
  UserStory,
  UserStoryAgentRun,
  UserStoryAgentRunUpdate,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import { userStoryDisplayId } from "@/components/backlog/data/backlog-data"
import { nextCheckpointRunCount } from "@/components/chat/agent-run-checkpoints"
import {
  agentEventText,
  agentFlowUpdate,
  cancelledAgentRun,
  completedAgentRun,
  failedAgentRun,
  resumableAgentFailure,
  shouldPersistAgentEvent,
  terminalAgentRunEvent,
} from "@/components/backlog/data/agent-flow"
import { subscribeAgentEvents } from "@/components/backlog/data/agent-event-stream"
import {
  agentPersistenceEvent,
  AgentStreamCoordinator,
  type AgentStreamSnapshotPersistence,
} from "@/components/backlog/data/agent-stream-coordinator"
import { persistTerminalAgentUpdate } from "@/components/backlog/data/agent-terminal-outbox"
import {
  pendingAgentRunSnapshots,
  persistAgentSnapshot,
} from "@/components/backlog/data/agent-snapshot-outbox"
import {
  agentRunFinalization,
  agentRunOwnsStory,
  agentUpdateKey,
} from "@/components/backlog/data/agent-run-lifecycle"
import { boundedAgentMessage } from "@/components/backlog/data/agent-update-limits"
import { persistAgentRunDiffEndRef } from "@/components/backlog/data/agent-run-diff-end-ref"
import {
  completedClineLog,
  finalAssistantResponse,
} from "@/components/backlog/data/agent-run-recovery"
import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { storyPreviewDevtoolsScope } from "@/components/backlog/shared/preview-devtools-scope"
import { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import type { HostDependencyReport } from "@/context/platform"
import { useRuntimeGate } from "@/pages/backlog/use-runtime-gate"
import { deadAgentRuns } from "@/pages/backlog/agent-run-liveness"
import {
  closeStoryRunStreams,
  forgetRunStream,
  registerRunStream,
  runStreamOpen,
} from "@/components/backlog/data/agent-run-streams"
import { pendingTerminalAgentUpdates } from "@/components/backlog/data/agent-terminal-outbox"
import { storiesInTransition } from "@/pages/backlog/story-transitions"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { createCloudApi } from "@/lib/cloud-api"
import { effectiveProjectCodePractices } from "@/lib/project-code-practice-preferences"
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
  activeStory,
  activityUpdates,
  agentAuthenticationErrorKey,
  agentMetadataUpdate,
  agentRunEventUpdate,
  agentRunMetadataUpdate,
  clearPendingAgentUpdates,
  clineLogPath,
  clineLogRelativePath,
  definedUpdate,
  directQueueNotice,
  directStorySlots,
  errorMessage,
  expiredAuthenticationToken,
  type HostDependenciesDialogState,
  nextAgentRun,
  notifyCommentResponseCompleted,
  pausedAgentUpdate,
  pendingAgentUpdate,
  type PendingAgentUpdate,
  previewRecoveryStateKey,
  projectInitializing,
  type QueuedAgentUpdate,
  queuedStories,
  recoverableAgentRun,
  recoveredMessageCount,
  reportAgentPersistenceError,
  rotationBlocker,
  runFlowState,
  runningAgentRunsForStory,
  runningStories,
  staleAgentRunAge,
  storyTelemetryCohorts,
} from "./backlog-rotation-helpers"

const maxConcurrentDevelopmentStories = 3
const blockerRetryDelay = 30_000
const previewRecoveryIntervalMs = 30_000
const agentCompletionRecoveryIntervalMs = 60_000
const agentEventPersistDelayMs = 1_500
const interruptedAgentMessage =
  "Agent interrupted while Blame was offline. Resume when ready."
const setupToastId = "backlog-rotation-setup"
const authToastId = "backlog-agent-auth"
const initializationRetryDelay = 5_000

export function useBacklogRotation(
  backlog: ReturnType<typeof useBacklogStore>
) {
  const auth = useCloudAuth()
  const platform = usePlatform()
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
  const reportedAgentErrors = React.useRef(new Set<string>())
  const pendingAgentUpdates = React.useRef(
    new Map<string, PendingAgentUpdate>()
  )
  const agentStreamClosers = React.useRef(new Set<() => void>())
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
  const resumeRunningAgentStreamsRef = React.useRef<
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

  React.useEffect(() => {
    storiesRef.current = backlog.stories
  }, [backlog.stories])

  React.useEffect(() => {
    blockedStories.current.clear()
    reportedBlockers.current.clear()
    reportedAgentErrors.current.clear()
    clearPendingAgentUpdates(pendingAgentUpdates.current)
    agentAuthenticationBlockedUntil.current = 0
    previewRecoveryStoryIds.current.clear()
    agentCompletionRecoveryStoryIds.current.clear()
    interruptedAgentRecoveryStoryIds.current.clear()
  }, [projects.activeProject?.id, selection.currentModel?.id])

  React.useEffect(
    () => () => {
      clearPendingAgentUpdates(pendingAgentUpdates.current)
      agentStreamClosers.current.forEach((close) => close())
      agentStreamClosers.current.clear()
    },
    []
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
    const initialization = projectInitialization.initialization

    if (initialization?.status !== "done" || !initialization.previewManifest) {
      if (projectInitializing(initialization?.status))
        return retryStory(detailedStory)
      reportBlocker(
        detailedStory,
        "Project initialization is required before starting queued user stories."
      )
      return
    }

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
    })
    if (!dependencies.ok) {
      reportHostDependencyBlocker(
        detailedStory,
        dependencies,
        previewProfile
      )
      return
    }

    const executionId = crypto.randomUUID()
    const storyId = detailedStory.id
    const telemetryCohorts = storyTelemetryCohorts(
      detailedStory,
      selection.currentModel.id,
      selection.currentModel.provider.id
    )
    const worktree = await workspace.createWorktree({
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
    await backlog.update(detailedStory, {
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
    let started: { run: UserStoryAgentRun; sessionId: string } | undefined
    try {
      const preparationPromise = direct
        ? Promise.resolve()
        : workspace.prepareProjectPreview({
        executionId,
        storyId,
        telemetryCohorts,
        worktree: worktree.worktree,
        previewManifest: initialization.previewManifest,
        runConfigurations: initialization.runConfigurations,
        runConfigurationId: detailedStory.runConfigurationId,
        hostDependenciesChecked: true,
        runtimeProfile: previewProfile,
      })
      sessionPromise = agent.sessions.startDevelopment({
        apiConnection: auth.apiConnection,
        providerId: selection.currentModel.provider.id,
        modelId: selection.currentModel.id,
        credentialLabel: selection.currentModel.credentialLabel,
        reasoningEffort: selection.currentVariant,
        autoSendPrompt: false,
        title: detailedStory.title,
        summary: detailedStory.summary,
        codeSelectionAttachments: detailedStory.codeSelectionAttachments ?? [],
        fileAttachments: detailedStory.fileAttachments ?? [],
        cwd: worktree.worktree,
        workspaceRoot: worktree.worktree,
        workspaceMode: worktree.workspaceMode,
        // No managed preview in Direct mode.
        previewDevtoolsScope: direct
          ? undefined
          : storyPreviewDevtoolsScope(detailedStory.id),
        codePractices: effectiveProjectCodePractices(
          projectInitialization.practices
        ),
        projectInitialization: {
          previewManifest: initialization.previewManifest,
          runConfigurations: initialization.runConfigurations,
          databaseMode: initialization.databaseMode,
        },
        executionId,
        projectId: detailedStory.projectId,
        storyId,
      })
      void sessionPromise.catch(() => undefined)
      await preparationPromise
      if (
        worktree.workspaceMode === "local-container" &&
        typeof detailedStory.runConfigurationId === "string" &&
        workspace.controlProjectPreview
      ) {
        void workspace
          .controlProjectPreview({
            action: "start",
            configurationId: detailedStory.runConfigurationId,
            worktree: worktree.worktree,
          })
          .then((runtime) => {
            if (runtime.previewUrl) {
              return backlog.update(detailedStory, {
                previewUrl: runtime.previewUrl,
              })
            }
          })
          .catch(() => undefined)
      }
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
      subscribeStoryStream(detailedStory, run, session.sessionId, executionId)

      await backlog.update(detailedStory, {
        agentModelId: selection.currentModel.id,
        agentProviderId: selection.currentModel.provider.id,
        agentActivities: [],
        agentFinalResponse: null,
        agentUsage: null,
        agentStatus: "Running",
        agentLastEvent: `Cline debug log: ${clineLogPath(worktree.worktree, session.sessionId)}`,
        clineSessionId: session.sessionId,
      })
      started = { run, sessionId: session.sessionId }
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
    const { run, sessionId: startedSession } = started
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
        persistAgentEvent(detailedStory, run, {
          type: "error",
          sessionId: session.sessionId,
          executionId,
          payload: { message: errorMessage(error) },
        })
      )
      .catch(reportAgentPersistenceError)
  }

  // Up to three agents at a time; Direct stories share the project folder,
  // so only one of them runs (or waits for review) at a time.
  function storiesToStartNow(readyStories: UserStory[]) {
    const stories = storiesRef.current
    let slots =
      maxConcurrentDevelopmentStories -
      runningStories(stories) -
      startingStoryIds.current.size
    const isDirect = (story: UserStory) => storyRunMode(story) === "direct"
    const startingDirect = stories.filter(
      (story) => startingStoryIds.current.has(story.id) && isDirect(story)
    ).length
    let directFree = directStorySlots(stories, startingDirect) > 0
    const selected: UserStory[] = []
    for (const story of readyStories) {
      if (slots <= 0) break
      if (isDirect(story)) {
        if (!directFree) continue
        directFree = false
      }
      selected.push(story)
      slots -= 1
    }
    return selected
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
    toast.error("Cloud Preview needs Blame Premium", {
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
        includeRuntime: runtimeGate.hostCheckIncludesRuntime,
        runtimeProfile: current.runtimeProfile,
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

  async function persistAgentEvent(
    story: UserStory,
    run: UserStoryAgentRun | undefined,
    event: AgentEvent,
    prepared?: AgentStreamSnapshotPersistence
  ) {
    const currentStory = activeStory(story, storiesRef.current)
    const flowUpdate = prepared?.update ?? agentFlowUpdate(currentStory, event)
    const text = agentEventText(event)
    const runInput = agentRunEventUpdate(flowUpdate, event, text)
    if (run) {
      runInput.persistenceEvent =
        prepared?.persistenceEvent ??
        agentPersistenceEvent(event, {
          executionId: run.executionId ?? event.executionId ?? run.id,
          lastSequenceNumber: run.lastSequenceNumber,
          runId: run.id,
          sessionId:
            event.sessionId ??
            run.clineSessionId ??
            currentStory.clineSessionId ??
            run.id,
        })
    }
    if (!shouldPersistAgentEvent(event, flowUpdate)) return
    if (
      prepared &&
      run &&
      !terminalAgentRunEvent(event) &&
      !expiredAuthenticationToken(text)
    ) {
      await persistAgentSnapshot(
        window.localStorage,
        {
          event: prepared.persistenceEvent,
          messageId: flowUpdate.agentActivity?.id ?? event.type,
          projectId: currentStory.projectId,
          runId: run.id,
          targetId: currentStory.id,
          targetType: "user-story",
          update: runInput,
        },
        (snapshot) =>
          backlog.updateAgentRun(
            currentStory,
            run,
            snapshot.update as UserStoryAgentRunUpdate
          )
      )
      return
    }
    if (reportedAgentErrors.current.has(agentAuthenticationErrorKey(story, run)))
      return
    if (expiredAuthenticationToken(text)) {
      reportExpiredAuthenticationToken(story, text, run)
      persistAgentUpdate(
        currentStory,
        {
          ...flowUpdate,
          agentLastError: boundedAgentMessage(
            text,
            "Agent authentication failed"
          ),
          agentLastEvent: boundedAgentMessage(
            text,
            "Agent authentication failed"
          ),
          agentStatus: "Paused",
        },
        run,
        runInput,
        true
      )
      return
    }
    if (completedAgentRun(event)) {
      notifyCommentResponseCompleted(currentStory, run, platform)
      await persistTerminalAgentTransition(
        currentStory,
        {
          ...flowUpdate,
          agentLastError: null,
          agentLastEvent: "Agent completed. Ready for review.",
          agentStatus: null,
          status: "in-review",
        },
        run,
        runInput
      )
      return
    }
    if (cancelledAgentRun(event)) {
      await persistTerminalAgentTransition(
        currentStory,
        {
          ...flowUpdate,
          agentLastError: null,
          agentLastEvent: boundedAgentMessage(text, "Agent stopped."),
          agentStatus: null,
          status: "in-review",
        },
        run,
        runInput
      )
      return
    }
    if (failedAgentRun(event)) {
      const resumable = resumableAgentFailure(text)
      await persistTerminalAgentTransition(
        currentStory,
        {
          ...flowUpdate,
          agentLastError: boundedAgentMessage(text, "Agent session failed"),
          agentLastEvent: boundedAgentMessage(text, "Agent session failed"),
          agentStatus: resumable ? "Paused" : null,
          status: resumable ? "in-progress" : "in-review",
        },
        run,
        runInput
      )
      return
    }
    persistAgentUpdate(
      currentStory,
      {
        ...flowUpdate,
        agentLastError:
          event.type === "error"
            ? boundedAgentMessage(text, "Agent session failed")
            : undefined,
        agentLastEvent: boundedAgentMessage(text, event.type),
      },
      run,
      runInput,
      terminalAgentRunEvent(event)
    )
  }

  function createStoryStreamCoordinator(
    story: UserStory,
    run: UserStoryAgentRun,
    sessionId: string,
    executionId = run.executionId ?? run.id
  ) {
    return new AgentStreamCoordinator({
      executionId,
      initialState: runFlowState(run),
      lastSequenceNumber: run.lastSequenceNumber,
      onError: reportAgentPersistenceError,
      persist: (snapshot) =>
        persistAgentEvent(story, run, snapshot.event, snapshot),
      runId: run.id,
      recoveredSnapshots: pendingAgentRunSnapshots(
        window.localStorage,
        story.projectId,
        "user-story",
        run.id
      ),
      sessionId,
    })
  }

  function subscribeStoryStream(
    story: UserStory,
    run: UserStoryAgentRun,
    sessionId: string,
    executionId?: string
  ) {
    if (runStreamOpen(run.id)) return
    closeStoryRunStreams(story.id, run.id)
    const coordinator = createStoryStreamCoordinator(
      story,
      run,
      sessionId,
      executionId
    )
    let unsubscribeSession: () => void = () => undefined
    const close = () => {
      unsubscribeSession()
      agentStreamClosers.current.delete(close)
      forgetRunStream(run.id, close)
      void coordinator.disconnect().catch(reportAgentPersistenceError)
    }
    registerRunStream(run.id, story.id, close)
    unsubscribeSession = subscribeAgentEvents(
      platform,
      sessionId,
      (event) => {
        const persisted = terminalAgentRunEvent(event)
          ? coordinator.terminate(event)
          : coordinator.push(event)
        if (terminalAgentRunEvent(event)) {
          void persisted.then(close, (error) => {
            reportAgentPersistenceError(error)
            close()
          })
        }
      },
      executionId ?? run.executionId ?? undefined,
      run.lastSequenceNumber ?? 0
    )
    agentStreamClosers.current.add(close)
  }

  React.useEffect(() => {
    resumeRunningAgentStreamsRef.current = (stories) => {
      stories.forEach((story) => {
        runningAgentRunsForStory(story).forEach((run) => {
          const sessionId = run.clineSessionId ?? story.clineSessionId
          if (!sessionId || runStreamOpen(run.id)) return
          subscribeStoryStream(story, run, sessionId)
        })
      })
    }
  })

  React.useEffect(() => {
    if (!platform.agent || backlog.loading) return
    resumeRunningAgentStreamsRef.current(backlog.stories)
  }, [backlog.loading, backlog.stories, platform.agent])

  function persistAgentUpdate(
    story: UserStory,
    input: UserStoryUpdate,
    run: UserStoryAgentRun | undefined,
    runInput: UserStoryAgentRunUpdate,
    immediate: boolean
  ) {
    const storyInput = agentRunOwnsStory(story, run) ? input : {}
    const nextStory = updateLocalStory(story, storyInput, run, runInput)
    if (immediate) {
      void flushAgentUpdate(nextStory, run, storyInput, runInput).catch(
        reportAgentPersistenceError
      )
      return
    }
    queueAgentUpdate(nextStory, run, storyInput, runInput)
  }

  async function persistTerminalAgentTransition(
    story: UserStory,
    input: UserStoryUpdate,
    run: UserStoryAgentRun | undefined,
    runInput: UserStoryAgentRunUpdate
  ) {
    const storyInput = agentRunOwnsStory(story, run) ? input : {}
    const nextStory = updateLocalStory(story, storyInput, run, runInput)
    recordPerformanceEvent("agent.transition.local_terminal_update", {
      eventType: runInput.status ?? "terminal",
    })
    await flushAgentUpdate(nextStory, run, storyInput, runInput)
    if (run && !run.diffEndRef) {
      void persistAgentRunDiffEndRef(story, run, platform, backlog).catch(
        reportAgentPersistenceError
      )
    }
  }

  function updateLocalStory(
    story: UserStory,
    input: UserStoryUpdate,
    run?: UserStoryAgentRun,
    runInput?: UserStoryAgentRunUpdate
  ) {
    const currentStory = activeStory(story, storiesRef.current)
    const nextStory = { ...currentStory, ...definedUpdate(input) }
    storiesRef.current = storiesRef.current.map((current) =>
      current.id === story.id ? nextStory : current
    )
    backlog.updateAgentLocal(currentStory, input, run, runInput)
    return nextStory
  }

  function queueAgentUpdate(
    story: UserStory,
    run: UserStoryAgentRun | undefined,
    input: UserStoryUpdate,
    runInput: UserStoryAgentRunUpdate
  ) {
    const key = agentUpdateKey(story, run)
    const pending = pendingAgentUpdates.current.get(key)
    if (pending) window.clearTimeout(pending.timer)
    const update = pendingAgentUpdate(pending, input, run, runInput)
    const timer = window.setTimeout(() => {
      pendingAgentUpdates.current.delete(key)
      void persistQueuedAgentUpdate(story, update).catch(() => undefined)
    }, agentEventPersistDelayMs)
    pendingAgentUpdates.current.set(key, { ...update, timer })
  }

  function flushAgentUpdate(
    story: UserStory,
    run: UserStoryAgentRun | undefined,
    input: UserStoryUpdate,
    runInput: UserStoryAgentRunUpdate
  ) {
    const key = agentUpdateKey(story, run)
    const pending = pendingAgentUpdates.current.get(key)
    if (pending) window.clearTimeout(pending.timer)
    pendingAgentUpdates.current.delete(key)
    const update = pendingAgentUpdate(pending, input, run, runInput)
    return persistTerminalAgentUpdate(window.localStorage, story, update, () =>
      persistTerminalQueuedAgentUpdate(story, update)
    )
  }

  function persistTerminalQueuedAgentUpdate(
    story: UserStory,
    update: QueuedAgentUpdate
  ) {
    const finalization = agentRunFinalization(
      update.activities,
      update.input,
      update.runInput,
      pausedAgentUpdate(update.input) ? "paused" : "review"
    )
    if (!update.run || !finalization) {
      return persistQueuedAgentUpdate(story, update)
    }
    return backlog.finalizeAgentRun(story, update.run, finalization)
  }

  async function persistQueuedAgentUpdate(
    story: UserStory,
    update: QueuedAgentUpdate
  ) {
    let nextStory = activeStory(story, storiesRef.current)
    const metadata = agentMetadataUpdate(update.input)
    if (
      agentRunOwnsStory(
        activeStory(nextStory, storiesRef.current),
        update.run
      ) &&
      Object.keys(definedUpdate(metadata)).length
    ) {
      nextStory = await backlog.update(
        activeStory(nextStory, storiesRef.current),
        metadata
      )
    }
    if (update.activities.length) {
      if (update.run) {
        await backlog.updateAgentRun(nextStory, update.run, {
          agentActivityUpdates: update.activities,
        })
      } else if (
        agentRunOwnsStory(
          activeStory(nextStory, storiesRef.current),
          update.run
        )
      ) {
        nextStory = await backlog.update(
          activeStory(nextStory, storiesRef.current),
          { agentActivityUpdates: update.activities }
        )
      }
    }
    if (update.run) {
      const runMetadata = agentRunMetadataUpdate(update.runInput)
      if (Object.keys(definedUpdate(runMetadata)).length) {
        await backlog.updateAgentRun(nextStory, update.run, runMetadata)
      }
    }
    return nextStory
  }

  function reportExpiredAuthenticationToken(
    story: UserStory,
    message: string,
    run?: UserStoryAgentRun
  ) {
    const key = agentAuthenticationErrorKey(story, run)
    if (reportedAgentErrors.current.has(key)) return
    agentAuthenticationBlockedUntil.current = Date.now() + blockerRetryDelay
    window.setTimeout(
      () => refreshStartingStories((value) => value + 1),
      blockerRetryDelay
    )
    reportedAgentErrors.current.add(key)
    toast.error("Agent authentication expired", {
      description: `${message} Reconnect the selected provider, then restart the story.`,
      id: `${authToastId}-${story.id}`,
      position: "bottom-right",
    })
  }

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
    runtimeWaitingLabel:
      runtimeGate.waitingLabel ??
      directQueueNotice(backlog.stories, (story) => storyRunMode(story) === "direct"),
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
