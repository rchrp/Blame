import { createDebouncedUpdateQueue } from "@/lib/debounced-update-queue"
import type { AgentEvent, ReasoningSelection } from "@blame/agent-runtime"
import * as React from "react"
import { toast } from "sonner"

import type {
  RejectChoice,
  StopAgentChoice,
} from "@/components/backlog/actions/story-action-dialogs"
import { BacklogColumn } from "@/components/backlog/board/backlog-column"
import { BacklogToolbar } from "@/components/backlog/board/backlog-toolbar"
import { PlanModeLauncher } from "@/components/backlog/planning/plan-mode-dialog"
import { subscribeAgentEvents } from "@/components/backlog/data/agent-event-stream"
import {
  agentEventText,
  completedAgentRun,
  shouldPersistAgentEvent,
  terminalAgentRunEvent,
} from "@/components/backlog/data/agent-flow"
import { persistAgentRunDiffEndRef } from "@/components/backlog/data/agent-run-diff-end-ref"
import {
  agentRunFinalization,
  agentRunOwnsStory,
  agentUpdateKey,
} from "@/components/backlog/data/agent-run-lifecycle"
import {
  pendingAgentRunSnapshots,
  persistAgentSnapshot,
  replayAgentSnapshots,
} from "@/components/backlog/data/agent-snapshot-outbox"
import {
  agentPersistenceEvent,
  AgentStreamCoordinator,
  type AgentStreamSnapshotPersistence,
} from "@/components/backlog/data/agent-stream-coordinator"
import { agentStreamStore } from "@/components/backlog/data/agent-stream-store"
import { persistTerminalAgentUpdate } from "@/components/backlog/data/agent-terminal-outbox"
import { replayTerminalAgentUpdates } from "@/components/backlog/data/agent-terminal-replay"
import { afterRendererPaint } from "@/components/backlog/data/agent-transition-scheduling"
import type {
  BacklogAction,
  BacklogColumnId,
  UserStory,
  UserStoryAgentRun,
  UserStoryAgentRunUpdate,
  UserStoryCodeSelectionAttachment,
  UserStoryDraft,
  UserStoryFileAttachment,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import {
  backlogColumns,
} from "@/components/backlog/data/backlog-data"
import {
  selectBacklogStory,
  selectedBacklogStoryId,
  subscribeToBacklogStorySelection,
  takeSelectedBacklogStoryAction,
} from "@/components/backlog/data/backlog-navigation"
import { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { completedStoryReference } from "@/components/backlog/data/user-story-context"
import { useUserStoryDiffStats } from "@/components/backlog/development/user-story-diff-stats"
import { stopManagedCloudPreview } from "@/components/backlog/drawer/use-user-story-preview-runner"
import { UserStoryDrawer } from "@/components/backlog/drawer/user-story-drawer"
import { UserStoryPreviewWarmup } from "@/components/backlog/drawer/user-story-preview"
import { drawerTargetForAction } from "@/components/backlog/shared/backlog-helpers"
import type { DrawerTarget } from "@/components/backlog/shared/backlog-types"
import { storyPreviewDevtoolsScope } from "@/components/backlog/shared/preview-devtools-scope"
import type { AgentConversationUserMessageUndo } from "@/components/chat/agent-conversation"
import { newUserStoryEvent } from "@/components/navigation/command-palette"
import { nextCheckpointRunCount } from "@/components/chat/agent-run-checkpoints"
import {
  modelForPreference,
  useModelSelection,
} from "@/components/model/model-selection"
import { storyMaxInputTokens } from "@/components/backlog/data/story-context-limit"
import { storyModelChoice } from "@/components/backlog/data/story-model-choice"
import {
  projectInitializing,
  useProjectInitialization,
} from "@/components/project-initialization/use-project-initialization"
import { KanbanBoard } from "@/components/shared/kanban-board"
import { BacklogDragDrop } from "@/components/backlog/board/backlog-drag-drop"
import { useCloudAuth } from "@/context/cloud-auth"
import {
  usePlatform,
  type BacklogStatusPipRequest,
  type Platform,
} from "@/context/platform"
import { useProjects } from "@/context/projects"
import {
  measurePerformanceOperation,
  recordPerformanceCount,
  recordPerformanceEvent,
  recordPerformanceMetric,
} from "@/lib/performance-diagnostics"
import { projectCodePractices } from "@/lib/project-code-practices"
import { showSystemNotification } from "@/lib/system-notifications"
import { celebrateStory } from "@/lib/celebrate"
import { notifyCommentResponseCompleted } from "@/pages/backlog/backlog-rotation-helpers"
import { OpenProjectEmptyState } from "@/components/shared/open-project-empty-state"
import { backlogStatusPipStories } from "@/pages/backlog/backlog-status-pip-snapshot"
import { HostDependenciesDialog } from "@/pages/backlog/host-dependencies-dialog"
import {
  parseProjectPreviewRepairCandidate,
  type ProjectPreviewRepairCandidate,
} from "@/pages/backlog/project-initialization-database"
import {
  assessAndRepairProjectInitializationImpact,
  type ProjectInitializationImpactRepairResult,
} from "@/pages/backlog/project-initialization-impact"
import { currentReviewDiffEmpty } from "@/pages/backlog/review-diff-evidence"
import { useBacklogRotation } from "@/pages/backlog/use-backlog-rotation"
import {
  agentEventUpdate,
  agentMetadataUpdate,
  agentRunEventUpdate,
  agentRunMetadataUpdate,
  definedUpdate,
  expiredAuthenticationToken,
  immediateAgentEvent,
  pausedAgentUpdate,
  pendingAgentUpdate,
  type QueuedAgentUpdate,
} from "../../components/backlog/data/user-story-agent-updates"
import {
  queuedUserStoryTitleRequest,
  runQueuedStoryTitleGeneration,
  titleGenerationStoryIds,
} from "./backlog-title-generation"
import {
  abortStoryAgent,
  deleteUserStoryWithRuntime,
  removeStoryWorktree,
  stopStoryProjectSetup,
} from "./story-runtime-cleanup"
import { activeStory, inactiveStoryFields } from "./story-runtime-state"
import {
  closeStoryRunStreams,
  forgetRunStream,
  registerRunStream,
  runStreamOpen,
} from "@/components/backlog/data/agent-run-streams"
import { useReviewCompletion } from "./use-review-completion"
import { finalizeStoppedRun } from "./story-agent-control"
import {
  useQueuedCommentDelivery,
  useStoryComments,
} from "./use-story-comments"
import { useResumeSlots } from "./use-resume-slots"
import { withStoryTransition } from "./story-transitions"

const agentEventPersistDelayMs = 1_500
const terminalAgentRetryIntervalMs = 60_000

export function BacklogPage({ active = true }: { active?: boolean }) {
  recordPerformanceCount("backlog.render")
  const backlog = useBacklogStore()
  const auth = useCloudAuth()
  const platform = usePlatform()
  const projects = useProjects()
  const agentSelection = useModelSelection({ role: "agent" })
  const alternativeSelection = useModelSelection({ role: "alternative" })
  const rotation = useBacklogRotation(backlog)
  const [drawerTarget, setDrawerTarget] = React.useState<DrawerTarget>()
  const [titleGeneratingStoryIds, setTitleGeneratingStoryIds] = React.useState(
    () => new Set<string>()
  )
  const projectInitialization = useProjectInitialization()
  const initializationStatus = projectInitialization?.status ?? null
  const queueInitializing = projectInitializing(initializationStatus)
  const userStoryDiffStats = useUserStoryDiffStats(
    backlog.stories,
    platform.workspace,
    projects.activeProject?.path
  )
  const serializedStatusPipStories = JSON.stringify(
    backlogStatusPipStories(backlog.stories)
  )
  const statusPipStories = React.useMemo(
    () => JSON.parse(serializedStatusPipStories) as UserStory[],
    [serializedStatusPipStories]
  )
  const storiesRef = React.useRef(backlog.stories)
  const openDrawerRef = React.useRef<(target: DrawerTarget) => void>(() => {})
  const drawerLoadRequestId = React.useRef(0)
  const previousStoryStatuses = React.useRef<
    Map<string, BacklogColumnId> | undefined
  >(undefined)
  const pendingAgentUpdates = React.useRef(
    createDebouncedUpdateQueue<QueuedAgentUpdate>(agentEventPersistDelayMs)
  )
  const agentStreamClosers = React.useRef(new Map<string, () => void>())
  const retryingTerminalAgentUpdates = React.useRef(false)
  const backlogRef = React.useRef(backlog)
  const persistTerminalAgentUpdateRef = React.useRef<
    (story: UserStory, update: QueuedAgentUpdate) => Promise<unknown>
  >(async () => undefined)

  React.useEffect(() => {
    backlogRef.current = backlog
  }, [backlog])

  React.useEffect(() => {
    storiesRef.current = backlog.stories
  }, [backlog.stories])

  React.useEffect(() => {
    notifyStoriesMovedToReview(
      backlog.stories,
      previousStoryStatuses.current,
      platform
    )
    previousStoryStatuses.current = storyStatusMap(backlog.stories)
  }, [backlog.stories, platform])

  React.useEffect(() => {
    if (!platform.backlogStatusPip) return
    recordPerformanceCount("backlog.status_pip.publish")
    recordPerformanceMetric(
      "backlog.status_pip.story_count",
      statusPipStories.length
    )
    platform.backlogStatusPip.publish({
      authStatus: auth.status,
      hasActiveProject: Boolean(projects.activeProject),
      // A refresh of an already loaded backlog is not "loading".
      loading: backlog.loading && !backlog.stories.length,
      stories: statusPipStories,
    })
  }, [
    auth.status,
    backlog.loading,
    backlog.stories.length,
    platform.backlogStatusPip,
    projects.activeProject,
    statusPipStories,
  ])

  React.useEffect(
    () => () => {
      pendingAgentUpdates.current.clear()
      agentStreamClosers.current.forEach((close) => close())
      agentStreamClosers.current.clear()
    },
    []
  )

  const drawerUserStory = React.useMemo(() => {
    if (!drawerTarget?.userStory) return undefined
    return (
      backlog.stories.find(
        (story) => story.id === drawerTarget.userStory?.id
      ) ?? drawerTarget.userStory
    )
  }, [backlog.stories, drawerTarget])
  const openDrawer = React.useCallback(
    (target: DrawerTarget) => {
      const requestId = ++drawerLoadRequestId.current
      setDrawerTarget(target)
      if (!target.userStory) {
        return
      }
      const currentStory = activeStory(target.userStory, storiesRef.current)
      if (backlog.storyDetailsLoaded(currentStory)) {
        setDrawerTarget({ ...target, userStory: currentStory })
        return
      }
      void backlog
        .loadDetail(currentStory)
        .then(() => {
          if (drawerLoadRequestId.current !== requestId) return
        })
        .catch((error) => {
          if (drawerLoadRequestId.current !== requestId) return
          toast.error("Unable to load user story details", {
            description: errorMessage(error),
            position: "bottom-right",
          })
        })
    },
    [backlog]
  )
  React.useEffect(() => {
    openDrawerRef.current = openDrawer
  }, [openDrawer])
  const openCreateDrawer = React.useCallback(() => {
    if (!backlog.projectPath) return
    drawerLoadRequestId.current += 1
    setDrawerTarget({
      mode: "create",
      initialTab: "user-story",
    })
  }, [backlog.projectPath])
  // "New user story" from the command palette.
  React.useEffect(() => {
    const handleNewStory = () => openCreateDrawer()
    window.addEventListener(newUserStoryEvent, handleNewStory)
    return () => window.removeEventListener(newUserStoryEvent, handleNewStory)
  }, [openCreateDrawer])
  React.useEffect(() => {
    const openSelectedStory = () => {
      const selectedStoryId = selectedBacklogStoryId()
      if (!selectedStoryId) {
        setDrawerTarget(undefined)
        return
      }
      const story = storiesRef.current.find(
        (item) => item.id === selectedStoryId
      )
      if (!story) return
      const action = takeSelectedBacklogStoryAction()
      openDrawerRef.current(
        action
          ? drawerTargetForAction(story, action)
          : { mode: "edit", userStory: story }
      )
    }
    const timer = window.setTimeout(openSelectedStory, 0)
    const unsubscribe = subscribeToBacklogStorySelection(openSelectedStory)
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [])
  const updateStoryLocal = React.useCallback(
    (
      story: UserStory,
      input: UserStoryUpdate,
      run?: UserStoryAgentRun,
      runInput?: UserStoryAgentRunUpdate
    ) => {
      const currentStory = activeStory(story, storiesRef.current)
      const nextStory = { ...currentStory, ...definedUpdate(input) }
      storiesRef.current = storiesRef.current.map((current) =>
        current.id === story.id ? nextStory : current
      )
      backlog.updateAgentLocal(currentStory, input, run, runInput)
      React.startTransition(() => {
        setDrawerTarget((current) =>
          current?.userStory?.id === story.id
            ? { ...current, userStory: nextStory }
            : current
        )
      })
      return nextStory
    },
    [backlog]
  )
  const updateStory = React.useCallback(
    async (
      story: UserStory,
      input: UserStoryUpdate,
      options: { cleanup?: boolean } = {}
    ) => {
      const currentStory = activeStory(story, storiesRef.current)
      const persistStoryUpdate = async (input: UserStoryUpdate) => {
        const nextStory = await backlog.update(currentStory, input)
        setDrawerTarget((current) =>
          current?.userStory?.id === currentStory.id
            ? { ...current, userStory: nextStory }
            : current
        )
        return nextStory
      }
      if (
        options.cleanup !== false &&
        asyncInactiveStoryCleanup(currentStory, input)
      ) {
        const nextStory = await persistStoryUpdate(input)
        void cleanupInactiveStory(
          currentStory,
          platform,
          projects.activeProject?.path,
          backlog
        )
        return nextStory
      }
      const cleanup =
        options.cleanup === false
          ? {}
          : await inactiveStoryCleanup(
              currentStory,
              input,
              platform,
              projects.activeProject?.path
            )
      return persistStoryUpdate({
        ...input,
        ...cleanup,
      })
    },
    [backlog, platform, projects.activeProject?.path]
  )
  const reviewDiffEmpty = React.useCallback(
    (story: UserStory) => userStoryDiffStats.get(story.id)?.files === 0,
    [userStoryDiffStats]
  )
  const storyDiffStats = React.useCallback(
    (story: UserStory) => userStoryDiffStats.get(story.id),
    [userStoryDiffStats]
  )
  const persistQueuedAgentUpdate = React.useCallback(
    async (story: UserStory, update: QueuedAgentUpdate) => {
      let nextStory = activeStory(story, storiesRef.current)
      const metadata = agentMetadataUpdate(update.input)
      if (
        agentRunOwnsStory(
          activeStory(nextStory, storiesRef.current),
          update.run
        ) &&
        Object.keys(definedUpdate(metadata)).length
      ) {
        nextStory = await updateStory(
          activeStory(nextStory, storiesRef.current),
          metadata,
          { cleanup: false }
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
          nextStory = await updateStory(
            activeStory(nextStory, storiesRef.current),
            { agentActivityUpdates: update.activities },
            { cleanup: false }
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
    },
    [backlog, updateStory]
  )
  const persistTerminalQueuedAgentUpdate = React.useCallback(
    (story: UserStory, update: QueuedAgentUpdate) => {
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
    },
    [backlog, persistQueuedAgentUpdate]
  )
  React.useEffect(() => {
    persistTerminalAgentUpdateRef.current = persistTerminalQueuedAgentUpdate
  }, [persistTerminalQueuedAgentUpdate])
  const retryTerminalAgentUpdates = React.useCallback(async () => {
    const currentBacklog = backlogRef.current
    const projectId = currentBacklog.projectId
    if (!projectId || retryingTerminalAgentUpdates.current) return
    retryingTerminalAgentUpdates.current = true
    try {
      await replayTerminalAgentUpdates(
        window.localStorage,
        currentBacklog,
        persistTerminalAgentUpdateRef.current,
        clearStoryAgentStream
      )
      await replayAgentSnapshots(
        window.localStorage,
        projectId,
        "user-story",
        async (snapshot) => {
          const story = currentBacklog.stories.find(
            (item) => item.id === snapshot.targetId
          )
          if (!story) return
          const detailedStory = await currentBacklog.loadDetail(story)
          const run = detailedStory.agentRuns?.find(
            (item) => item.id === snapshot.runId
          )
          if (!run) return
          const update = snapshot.update as UserStoryAgentRunUpdate
          if ((run.lastSequenceNumber ?? 0) >= snapshot.event.sequenceNumber) {
            if (terminalStoryAgentStatus(update.status)) {
              clearStoryAgentStream(detailedStory, run)
            }
            return
          }
          await currentBacklog.updateAgentRun(detailedStory, run, update)
          if (terminalStoryAgentStatus(update.status)) {
            clearStoryAgentStream(detailedStory, run)
          }
        }
      )
    } catch (error) {
      reportAgentPersistenceError(error)
    } finally {
      retryingTerminalAgentUpdates.current = false
    }
  }, [])

  React.useEffect(() => {
    if (backlog.loading || !backlog.projectId) return
    void retryTerminalAgentUpdates()
    const timer = window.setInterval(
      retryTerminalAgentUpdates,
      terminalAgentRetryIntervalMs
    )
    window.addEventListener("online", retryTerminalAgentUpdates)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("online", retryTerminalAgentUpdates)
    }
  }, [backlog.loading, backlog.projectId, retryTerminalAgentUpdates])

  const queueAgentUpdate = React.useCallback(
    (
      story: UserStory,
      run: UserStoryAgentRun | undefined,
      input: UserStoryUpdate,
      runInput: UserStoryAgentRunUpdate
    ) => {
      const key = agentUpdateKey(story, run)
      const pending = pendingAgentUpdates.current.get(key)
      const update = pendingAgentUpdate(pending, input, run, runInput)
      pendingAgentUpdates.current.schedule(key, update, (queued) => {
        void persistQueuedAgentUpdate(story, queued).catch(() => undefined)
      })
    },
    [persistQueuedAgentUpdate]
  )
  const flushAgentUpdate = React.useCallback(
    (
      story: UserStory,
      run: UserStoryAgentRun | undefined,
      input: UserStoryUpdate,
      runInput: UserStoryAgentRunUpdate
    ) => {
      const key = agentUpdateKey(story, run)
      const pending = pendingAgentUpdates.current.take(key)
      const update = pendingAgentUpdate(pending, input, run, runInput)
      return persistTerminalAgentUpdate(
        window.localStorage,
        story,
        update,
        () => persistTerminalQueuedAgentUpdate(story, update)
      )
    },
    [persistTerminalQueuedAgentUpdate]
  )
  const persistPreparedAgentUpdate = React.useCallback(
    (
      story: UserStory,
      run: UserStoryAgentRun | undefined,
      input: UserStoryUpdate,
      runInput: UserStoryAgentRunUpdate,
      immediate: boolean
    ) => {
      if (immediate) {
        return flushAgentUpdate(story, run, input, runInput).catch((error) => {
          reportAgentPersistenceError(error)
          throw error
        })
      }
      queueAgentUpdate(story, run, input, runInput)
      return Promise.resolve(undefined)
    },
    [flushAgentUpdate, queueAgentUpdate]
  )
  const persistAgentUpdate = React.useCallback(
    (
      story: UserStory,
      run: UserStoryAgentRun | undefined,
      input: UserStoryUpdate,
      runInput: UserStoryAgentRunUpdate,
      immediate: boolean
    ) => {
      const storyInput = agentRunOwnsStory(story, run) ? input : {}
      const nextStory = updateStoryLocal(story, storyInput, run, runInput)
      persistPreparedAgentUpdate(
        nextStory,
        run,
        storyInput,
        runInput,
        immediate
      )
    },
    [persistPreparedAgentUpdate, updateStoryLocal]
  )
  const persistAgentEvent = React.useCallback(
    async (
      story: UserStory,
      run: UserStoryAgentRun | undefined,
      event: AgentEvent,
      prepared?: AgentStreamSnapshotPersistence
    ) => {
      const currentStory = activeStory(story, storiesRef.current)
      const text = agentEventText(event)
      if (expiredAuthenticationToken(text)) {
        toast.error("Agent authentication expired", {
          description: `${text} Reconnect the selected provider, then restart the story.`,
          position: "bottom-right",
        })
      }
      const update = agentEventUpdate(currentStory, event, prepared?.update)
      if (!shouldPersistAgentEvent(event, update)) return
      const runInput = agentRunEventUpdate(update, event, text)
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
            messageId: update.agentActivity?.id ?? event.type,
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
      if (completedAgentRun(event))
        notifyCommentResponseCompleted(currentStory, run, platform)
      if (run && terminalAgentRunEvent(event) && !run.diffEndRef) {
        const storyInput = agentRunOwnsStory(currentStory, run) ? update : {}
        const nextStory = updateStoryLocal(
          currentStory,
          storyInput,
          run,
          runInput
        )
        recordPerformanceEvent("agent.transition.local_terminal_update", {
          eventType: event.type,
        })
        await persistPreparedAgentUpdate(
          nextStory,
          run,
          storyInput,
          runInput,
          true
        )
        void persistAgentRunDiffEndRef(
          currentStory,
          run,
          platform,
          backlog
        ).catch(reportAgentPersistenceError)
        return
      }
      persistAgentUpdate(
        currentStory,
        run,
        update,
        runInput,
        immediateAgentEvent(event)
      )
    },
    [
      backlog,
      persistAgentUpdate,
      persistPreparedAgentUpdate,
      platform,
      updateStoryLocal,
    ]
  )
  const subscribeStoryAgentEvents = React.useCallback(
    (
      story: UserStory,
      run: UserStoryAgentRun,
      sessionId: string,
      executionId: string
    ) => {
      agentStreamClosers.current.get(run.id)?.()
      // The background queue may already follow this run; one stream only.
      if (runStreamOpen(run.id)) return
      // The run this one replaces stops listening.
      closeStoryRunStreams(story.id, run.id)
      const coordinator = new AgentStreamCoordinator({
        executionId,
        initialState: {
          agentActivities: run.activities ?? story.agentActivities,
          agentFinalResponse: run.finalResponse ?? story.agentFinalResponse,
          agentSessionSummary: run.sessionSummary ?? story.agentSessionSummary,
          agentUsage: run.usage ?? story.agentUsage,
        },
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
      let authenticationFailed = false
      let unsubscribe: () => void = () => undefined
      const close = () => {
        unsubscribe()
        agentStreamClosers.current.delete(run.id)
        forgetRunStream(run.id, close)
        void coordinator.disconnect().catch(reportAgentPersistenceError)
      }
      registerRunStream(run.id, story.id, close)
      unsubscribe = subscribeAgentEvents(
        platform,
        sessionId,
        (event) => {
          if (authenticationFailed) return
          authenticationFailed = expiredAuthenticationToken(
            agentEventText(event)
          )
          const persisted = terminalAgentRunEvent(event)
            ? coordinator.terminate(event)
            : coordinator.push(event)
          if (authenticationFailed || terminalAgentRunEvent(event)) {
            void persisted.then(close, (error) => {
              reportAgentPersistenceError(error)
              close()
            })
          }
        },
        executionId,
        run.lastSequenceNumber ?? 0
      )
      agentStreamClosers.current.set(run.id, close)
    },
    [persistAgentEvent, platform]
  )
  const rejectStory = React.useCallback(
    async (story: UserStory, choice: RejectChoice) => {
      // The comment box opens; sending a comment is what resumes the agent.
      if (choice === "request-changes") return story
      return updateStory(story, {
        discardedReason: "Rejected during review",
        status: "discarded",
      })
    },
    [updateStory]
  )
  const openWorktree = React.useCallback(
    async (story: UserStory) => {
      if (!story.worktree) {
        toast.error("Unable to open worktree", {
          description: "This user story has no worktree.",
          position: "bottom-right",
        })
        return
      }
      if (!platform.openPath) {
        toast.error("Unable to open worktree", {
          description: "Desktop shell integration is not available.",
          position: "bottom-right",
        })
        return
      }
      const error = await platform.openPath(story.worktree)
      if (error) {
        toast.error("Unable to open worktree", {
          description: error,
          position: "bottom-right",
        })
      }
    },
    [platform]
  )
  const pauseStoryAgent = React.useCallback(
    async (story: UserStory) => {
      try {
        if (story.clineSessionId && story.agentStatus !== "Paused")
          await platform.agent?.sessions.abort(story.clineSessionId)
      } catch (error) {
        toast.error("Couldn't pause the agent", {
          description: errorMessage(error),
          position: "bottom-right",
        })
        return story
      }
      const message = "Paused by you."
      const paused = await finalizeStoppedRun(backlog, story, message)
      if (paused?.agentStatus === "Paused") return paused
      return updateStory(paused ?? story, {
        agentLastError: null,
        agentLastEvent: message,
        agentStatus: "Paused",
        status: "in-progress",
      })
    },
    [backlog, platform.agent, updateStory]
  )
  const stopAgent = React.useCallback(
    async (story: UserStory, choice: StopAgentChoice) => {
      if (choice === "pause" || choice === "pause-feedback") {
        // Paused stories stay in progress, with their preview, until resumed
        // or sent a comment.
        const paused = await withStoryTransition(story.id, () =>
          pauseStoryAgent(story)
        )
        return paused ?? story
      }
      if (choice === "discard-worktree") {
        return updateStory(story, {
          discardedReason: "Worktree discarded by user",
          status: "discarded",
        })
      }
      return updateStory(story, {
        discardedReason: null,
        status: "backlog",
      })
    },
    [pauseStoryAgent, updateStory]
  )
  const startStoryDevelopmentSession = React.useCallback(
    async (
      story: UserStory,
      input: {
        feedback?: string
        feedbackCodeSelectionAttachments?: UserStoryCodeSelectionAttachment[]
        feedbackFileAttachments?: UserStoryFileAttachment[]
        resumeSessionId?: string | null
        worktree: string
      }
    ) => {
      if (auth.status !== "authenticated")
        throw new Error("Reconnect the selected provider.")
      const agent = platform.agent
      if (!agent) throw new Error("Desktop agent runtime is not available.")
      // The story's own choice (its last model unless the person picked
      // another for it), else the default.
      const chosen = modelForPreference(
        agentSelection.models,
        storyModelChoice(story)
      )
      const model = chosen?.model ?? agentSelection.currentModel
      const reasoningEffort = chosen
        ? chosen.variant
        : agentSelection.currentVariant
      const providerId = model?.provider.id ?? story.agentProviderId
      const modelId = model?.id ?? story.agentModelId
      if (!providerId || !modelId)
        throw new Error("Select a model before resuming this user story.")
      const executionId = crypto.randomUUID()
      const storyId = story.id
      const session = await agent.sessions.startDevelopment({
        apiConnection: auth.apiConnection,
        providerId,
        modelId,
        credentialLabel: model?.credentialLabel,
        reasoningEffort,
        maxInputTokens: storyMaxInputTokens(
          story.id,
          model,
          agentSelection.allProviders
        ),
        autoSendPrompt: false,
        title: story.title,
        summary: story.summary,
        codeSelectionAttachments: story.codeSelectionAttachments ?? [],
        fileAttachments: story.fileAttachments ?? [],
        feedback: input.feedback,
        feedbackCodeSelectionAttachments:
          input.feedbackCodeSelectionAttachments,
        feedbackFileAttachments: input.feedbackFileAttachments,
        resumeSessionId: input.resumeSessionId,
        cwd: input.worktree,
        workspaceRoot: input.worktree,
        workspaceMode:
          story.workspaceMode ??
          (story.runMode === "vercel-compose" ? "cloud-mirror" : "local-container"),
        // Direct stories have no managed preview to inspect.
        previewDevtoolsScope:
          story.workspaceMode === "direct"
            ? undefined
            : storyPreviewDevtoolsScope(story.id),
        codePractices: await projectCodePractices(auth, projects),
        executionId,
        projectId: story.projectId,
        storyId,
      })
      return {
        ...session,
        executionId,
        model: { modelId, providerId, reasoningEffort: reasoningEffort ?? null },
        storyId,
      }
    },
    [
      auth,
      agentSelection.currentModel,
      agentSelection.currentVariant,
      agentSelection.models,
      platform.agent,
      projects,
    ]
  )
  const resumeStoryAgent = React.useCallback(
    async (story: UserStory) => {
      const currentStory = await detailedStory(story, backlog)
      if (!currentStory.worktree) {
        toast.error("Unable to resume agent", {
          description: "This user story has no active worktree.",
          position: "bottom-right",
        })
        return currentStory
      }
      if (auth.status !== "authenticated" || !agentSelection.currentModel) {
        toast.error("Unable to resume agent", {
          description: "Reconnect the provider and select a model.",
          position: "bottom-right",
        })
        return currentStory
      }
      const agent = platform.agent
      if (!agent) {
        toast.error("Unable to resume agent", {
          description: "Desktop agent runtime is not available.",
          position: "bottom-right",
        })
        return currentStory
      }
      const feedback = resumeAgentFeedback(
        currentStory,
        await currentDiffSummary(currentStory, platform)
      )
      const session = await startStoryDevelopmentSession(currentStory, {
        feedback,
        resumeSessionId: currentStory.clineSessionId,
        worktree: currentStory.worktree,
      })
      if (!session) {
        toast.error("Unable to resume agent", {
          description: "Desktop agent runtime is not available.",
          position: "bottom-right",
        })
        return currentStory
      }
      const run = await backlog.createAgentRun(currentStory, {
        checkpointRunCount: nextCheckpointRunCount(
          currentStory.agentRuns ?? []
        ),
        clineSessionId: session.sessionId,
        executionId: session.executionId,
        kind: "resume",
        ...session.model,
      })
      const updatedStory = await updateStory(currentStory, {
        agentLastError: null,
        agentLastEvent: `Cline debug log: ${clineLogPath(currentStory.worktree, session.sessionId)}`,
        agentActivities: [],
        agentFinalResponse: null,
        agentUsage: null,
        agentModelId: session.model.modelId,
        agentProviderId: session.model.providerId,
        agentStatus: "Running",
        clineSessionId: session.sessionId,
        status: "in-progress",
      })
      subscribeStoryAgentEvents(
        updatedStory,
        run,
        session.sessionId,
        session.executionId
      )
      void agent.sessions
        .sendDevelopment({
          executionId: session.executionId,
          sessionId: session.sessionId,
          storyId: session.storyId,
          title: currentStory.title,
          summary: currentStory.summary,
          codeSelectionAttachments: currentStory.codeSelectionAttachments ?? [],
          fileAttachments: currentStory.fileAttachments ?? [],
          feedback,
        })
        .catch((error) =>
          persistAgentEvent(updatedStory, run, {
            type: "error",
            sessionId: session.sessionId,
            executionId: session.executionId,
            payload: { message: errorMessage(error) },
          })
        )
        .catch(reportAgentPersistenceError)
      return updatedStory
    },
    [
      auth,
      backlog,
      platform,
      agentSelection.currentModel,
      startStoryDevelopmentSession,
      updateStory,
      subscribeStoryAgentEvents,
      persistAgentEvent,
    ]
  )
  // One resume at a time per story; failures say so instead of vanishing.
  const resumeInSlot = useLatestCallback(async (story: UserStory) => {
    const resumed = await withStoryTransition(story.id, () =>
      resumeStoryAgent(story).catch((error: unknown) => {
        toast.error("Couldn't resume the agent", {
          description: errorMessage(error),
          position: "bottom-right",
        })
        return story
      })
    )
    return resumed ?? story
  })
  const unpauseAgent = useResumeSlots({
    resume: resumeInSlot,
    stories: backlog.stories,
  })
  const requestChanges = useStoryComments({
    backlog,
    persistAgentEvent,
    platform,
    startStoryDevelopmentSession,
    subscribeStoryAgentEvents,
    updateStory,
  })
  useQueuedCommentDelivery({
    createComment: backlog.createComment,
    requestChanges,
    stories: backlog.stories,
  })
  const undoUserStoryComment = React.useCallback(
    async (story: UserStory, target: AgentConversationUserMessageUndo) => {
      const currentStory = await detailedStory(
        activeStory(story, storiesRef.current),
        backlog
      )
      await backlog.validateCommentUndo(
        currentStory,
        target.comment.id,
        target.run.id
      )
      const restored = await restoreStoryCheckpoint(
        platform,
        currentStory,
        target.run.clineSessionId ?? currentStory.clineSessionId,
        target.checkpointRunCount
      )
      const nextStory = await backlog.undoComment(
        currentStory,
        target.comment.id,
        { clineSessionId: restored.sessionId, runId: target.run.id }
      )
      replaceStoryAfterUndo(nextStory, storiesRef, setDrawerTarget)
      toast.success("Message restored to editor.", { position: "bottom-right" })
      return nextStory
    },
    [backlog, platform]
  )

  const approveAndMergeStory = React.useCallback(
    async (story: UserStory) => {
      const validationError = approveAndMergeValidationError(
        story,
        auth,
        platform,
        projects.activeProject?.path,
        alternativeSelection.currentModel
      )
      if (validationError) {
        toast.error("Unable to approve and merge", {
          description: validationError,
          position: "bottom-right",
        })
        return story
      }
      const runningStory = await updateStory(story, {
        agentLastError: null,
        agentLastEvent: "Approve & Merge started.",
        agentStatus: "Running",
      })
      try {
        const codePractices = await projectCodePractices(auth, projects)
        const result = await measurePerformanceOperation(
          "agent.transition.approve_merge",
          () =>
            platform.agent!.approveAndMerge({
              apiConnection: auth.apiConnection,
              executionId: crypto.randomUUID(),
              providerId: alternativeSelection.currentModel!.provider.id,
              modelId: alternativeSelection.currentModel!.id,
              credentialLabel:
                alternativeSelection.currentModel!.credentialLabel,
              reasoningEffort: alternativeSelection.currentVariant,
              repositoryRoot: projects.activeProject!.path,
              worktree: story.worktree!,
              storyBranch: story.branch!,
              title: story.title,
              summary: story.summary,
              storyId: story.id,
              codePractices,
            })
        )
        toast.success("Story approved and merged", {
          description: `Merged into ${result.targetBranch}.`,
          position: "bottom-right",
        })
        celebrateStory(story.id)
        const mergedStory = await updateStory(
          runningStory,
          {
            ...inactiveStoryFields(),
            agentLastError: null,
            agentLastEvent: `Merged into ${result.targetBranch}.`,
            baseCommit: result.baseCommit,
            mergeCommit: result.mergeCommit,
            mergedAt: new Date().toISOString(),
            status: "done",
          },
          { cleanup: false }
        )
        void runPostMergeTasks(
          runningStory,
          platform,
          projects.activeProject!.path,
          {
            auth,
            baseCommit: result.baseCommit,
            mergeCommit: result.mergeCommit,
            modelId: alternativeSelection.currentModel!.id,
            credentialLabel: alternativeSelection.currentModel!.credentialLabel,
            platform,
            projectId: projects.activeProject!.id,
            providerId: alternativeSelection.currentModel!.provider.id,
            reasoningEffort: alternativeSelection.currentVariant,
            repositoryRoot: projects.activeProject!.path,
          }
        )
        return mergedStory
      } catch (error) {
        const message = errorMessage(error)
        toast.error("Approve & Merge failed", {
          description: message,
          position: "bottom-right",
        })
        return updateStory(runningStory, {
          agentLastError: message,
          agentLastEvent: message,
          agentStatus: null,
        })
      }
    },
    [
      auth,
      platform,
      projects,
      alternativeSelection.currentModel,
      alternativeSelection.currentVariant,
      updateStory,
    ]
  )
  const { approveDirectStory, markReviewStoryDone } =
    useReviewCompletion(updateStory)
  const completeReviewStory = React.useCallback(
    async (story: UserStory) => {
      const emptyDiff = await currentReviewDiffEmpty(
        story,
        platform.workspace,
        projects.activeProject?.path
      )
      if (emptyDiff) return markReviewStoryDone(story)
      if (story.workspaceMode === "direct") return approveDirectStory(story)
      return approveAndMergeStory(story)
    },
    [
      approveAndMergeStory,
      approveDirectStory,
      markReviewStoryDone,
      platform.workspace,
      projects.activeProject?.path,
    ]
  )
  const optimizeUserStory = React.useCallback(
    (input: { summary: string; title: string }) =>
      optimizeUserStoryPrompt({
        input,
        auth,
        platform,
        projectPath: projects.activeProject?.path,
        model: alternativeSelection.currentModel,
        reasoningEffort: alternativeSelection.currentVariant,
      }),
    [
      auth,
      platform,
      projects.activeProject?.path,
      alternativeSelection.currentModel,
      alternativeSelection.currentVariant,
    ]
  )
  const storyTitleGenerating = React.useCallback(
    (story: UserStory) => titleGeneratingStoryIds.has(story.id),
    [titleGeneratingStoryIds]
  )
  const setStoryTitleGenerating = React.useCallback(
    (storyId: string, generating: boolean) => {
      setTitleGeneratingStoryIds((current) =>
        titleGenerationStoryIds(current, storyId, generating)
      )
    },
    []
  )
  const generateQueuedStoryTitle = React.useCallback(
    async (story: UserStory, beforeQueue = false) => {
      const request = queuedUserStoryTitleRequest({
        auth,
        model: alternativeSelection.currentModel,
        platform,
        projectPath: projects.activeProject?.path,
        reasoningEffort: alternativeSelection.currentVariant,
        runConfigurations:
          projectInitialization?.initialization?.runConfigurations ?? [],
        story: beforeQueue ? { ...story, status: "ready" } : story,
        updateStory,
      })
      if (!request) return
      setStoryTitleGenerating(story.id, true)
      try {
        return await runQueuedStoryTitleGeneration(request)
      } catch {
        return undefined
      } finally {
        setStoryTitleGenerating(story.id, false)
      }
    },
    [
      auth,
      alternativeSelection.currentModel,
      alternativeSelection.currentVariant,
      platform,
      projects.activeProject?.path,
      projectInitialization?.initialization?.runConfigurations,
      setStoryTitleGenerating,
      updateStory,
    ]
  )
  const runStoryAction = React.useCallback(
    async (story: UserStory, action: BacklogAction) => {
      const currentStory = await detailedStoryForAction(story, action, backlog)
      if (action === "Delete Permanently")
        return deleteUserStoryWithRuntime(
          currentStory,
          platform,
          projects.activeProject?.path,
          backlog.remove
        )
      if (action === "Send to Dev Agent") {
        const generatedStory = await generateQueuedStoryTitle(
          currentStory,
          true
        )
        return updateStory(generatedStory ?? currentStory, {
          status: "ready",
        })
      }
      if (action === "Discard") {
        return updateStory(currentStory, {
          discardedReason: "Discarded from backlog",
          status: "discarded",
        })
      }
      if (action === "Dequeue")
        return updateStory(currentStory, { status: "backlog" })
      if (action === "Rework") {
        return updateStory(currentStory, {
          discardedReason: null,
          status: "backlog",
        })
      }
      if (action === "Use Context") {
        drawerLoadRequestId.current += 1
        setDrawerTarget({
          initialDraft: { summary: completedStoryReference(currentStory) },
          initialTab: "user-story",
          mode: "create",
        })
        return
      }
      if (action === "Approve & Merge") return completeReviewStory(currentStory)
    },
    [
      completeReviewStory,
      generateQueuedStoryTitle,
      backlog,
      platform,
      projects.activeProject?.path,
      updateStory,
    ]
  )
  const runStatusPipRequest = React.useCallback(
    (request: BacklogStatusPipRequest) => {
      const story = storiesRef.current.find(
        (story) => story.id === request.storyId
      )
      if (!story) return
      const currentStory = activeStory(story, storiesRef.current)

      if (request.drawer) {
        openDrawer(statusPipDrawerTarget(currentStory, request))
        return
      }
      if (request.rejectChoice) {
        void rejectStory(currentStory, request.rejectChoice).catch(
          reportStatusPipRequestError
        )
        return
      }
      if (request.stopChoice) {
        void stopAgent(currentStory, request.stopChoice).catch(
          reportStatusPipRequestError
        )
        return
      }
      if (!request.action) return
      if (request.action === "Open Worktree") {
        void openWorktree(currentStory).catch(reportStatusPipRequestError)
        return
      }
      if (request.action === "Unpause Agent") {
        void unpauseAgent(currentStory).catch(reportStatusPipRequestError)
        return
      }
      if (
        request.action === "Open Preview" ||
        request.action === "View Diff" ||
        request.action === "View Files" ||
        request.action === "View Terminal" ||
        request.action === "Request Changes"
      ) {
        openDrawer(drawerTargetForAction(currentStory, request.action))
        return
      }
      void runStoryAction(currentStory, request.action).catch(
        reportStatusPipRequestError
      )
    },
    [
      openDrawer,
      openWorktree,
      rejectStory,
      runStoryAction,
      stopAgent,
      unpauseAgent,
    ]
  )
  React.useEffect(() => {
    return platform.backlogStatusPip?.onRequest(runStatusPipRequest)
  }, [platform.backlogStatusPip, runStatusPipRequest])
  const openStatusPip = React.useCallback(() => {
    void platform.backlogStatusPip?.open().catch((error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to open status picture in picture."
      )
    })
  }, [platform.backlogStatusPip])
  const columnAction = useLatestCallback(runStoryAction)
  const deleteStory = useLatestCallback(async (story: UserStory) =>
    deleteUserStoryWithRuntime(
      await detailedStory(story, backlog),
      platform,
      projects.activeProject?.path,
      backlog.remove
    )
  )
  const columnDeleteStory = deleteStory
  const columnOpenDrawer = useLatestCallback(openDrawer)
  const columnOpenWorktree = useLatestCallback(openWorktree)
  const columnRejectStory = useLatestCallback(rejectStory)
  const columnStopAgent = useLatestCallback(stopAgent)
  const columnUnpauseAgent = useLatestCallback(unpauseAgent)
  const closeDrawer = useLatestCallback((open: boolean) => {
    if (open) return
    drawerLoadRequestId.current += 1
    setDrawerTarget(undefined)
    selectBacklogStory(undefined)
  })
  const createDrawerStory = useLatestCallback(
    async (input: Omit<UserStoryDraft, "projectId">) => {
      const story = await backlog.create(input)
      void generateQueuedStoryTitle(story)
      setDrawerTarget({ userStory: story, mode: "edit" })
      return story
    }
  )
  const openPlannedStory = useLatestCallback((storyId: string) => {
    const userStory = backlog.stories.find((story) => story.id === storyId)
    if (userStory)
      openDrawer({
        userStory,
        mode: userStory.status === "backlog" ? "edit" : "view",
      })
  })
  const createDrawerComment = useLatestCallback(backlog.createComment)
  const deleteDrawerStory = deleteStory
  const updateDrawerStory = useLatestCallback(
    async (story: UserStory, input: UserStoryUpdate) => {
      const nextStory = await updateStory(story, input)
      void generateQueuedStoryTitle(nextStory)
      return nextStory
    }
  )
  const drawerOpenDrawer = useLatestCallback(openDrawer)
  const drawerOptimizeStory = useLatestCallback(optimizeUserStory)
  const drawerApproveStory = useLatestCallback(completeReviewStory)
  const drawerRequestChanges = useLatestCallback(requestChanges)
  const drawerRejectStory = useLatestCallback(rejectStory)
  const drawerStopAgent = useLatestCallback(stopAgent)
  const drawerUndoComment = useLatestCallback(undoUserStoryComment)

  return (
    <div className="flex h-svh min-h-0 min-w-0 flex-col gap-4 overflow-hidden px-4 pt-[calc(var(--header-height)+1rem)] pb-4 md:h-[calc(100svh_-_1rem)] lg:px-6 lg:pt-[calc(var(--header-height)+1.5rem)] lg:pb-6">
      <BacklogToolbar
        disabled={!backlog.projectPath}
        onOpenStatusPip={platform.backlogStatusPip ? openStatusPip : undefined}
        onCreateUserStory={openCreateDrawer}
        planAction={
          platform.agent?.planning ? (
            <PlanModeLauncher
              key={backlog.projectId}
              disabled={!backlog.projectPath}
              onOpenStory={openPlannedStory}
            />
          ) : undefined
        }
        storyCount={backlog.stories.length}
      />
      {backlog.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {backlog.error}
        </div>
      )}
      {!backlog.projectPath && (
        <OpenProjectEmptyState description="Open a project to plan user stories and let agents build them." />
      )}
      {backlog.projectPath ? (
      // Dropping a card runs the same action as its button.
      <BacklogDragDrop
        onDrop={(story, drop) => runStatusPipRequest({ ...drop.request, storyId: story.id })}
        reviewDiffEmpty={reviewDiffEmpty}
      >
      <KanbanBoard className="-mx-6 px-6" gridClassName="min-w-500 grid-cols-6">
        {backlogColumns.map((column) => (
          <BacklogColumn
            key={`${backlog.projectId ?? "no-project"}:${column.id}`}
            column={column}
            diffStats={storyDiffStats}
            onAction={columnAction}
            onCreateUserStory={openCreateDrawer}
            onDeleteUserStory={columnDeleteStory}
            onOpenDrawer={columnOpenDrawer}
            onOpenWorktree={columnOpenWorktree}
            onReject={columnRejectStory}
            reviewDiffEmpty={reviewDiffEmpty}
            onStopAgent={columnStopAgent}
            onUnpauseAgent={columnUnpauseAgent}
            queueInitializing={column.id === "ready" && queueInitializing}
            queueNotice={column.id === "ready" ? rotation.runtimeWaitingLabel : undefined}
            storyCleanup={backlog.storyCleanup}
            storySetupInitializing={backlog.storySetupInitializing}
            storyTitleGenerating={storyTitleGenerating}
            stories={backlog.storiesForColumn(column.id)}
            loading={backlog.loading}
          />
        ))}
      </KanbanBoard>
      </BacklogDragDrop>
      ) : null}
      <UserStoryDrawer
        diffStats={
          drawerUserStory ? storyDiffStats(drawerUserStory) : undefined
        }
        open={active && Boolean(drawerTarget)}
        onOpenChange={closeDrawer}
        userStory={drawerUserStory}
        mode={drawerTarget?.mode ?? "view"}
        initialDraft={drawerTarget?.initialDraft}
        initialTab={drawerTarget?.initialTab}
        initialDevelopmentTab={drawerTarget?.initialDevelopmentTab}
        focusComment={drawerTarget?.focusComment}
        onCreateUserStory={createDrawerStory}
        onCreateUserStoryComment={createDrawerComment}
        onDeleteUserStory={deleteDrawerStory}
        onUpdateUserStory={updateDrawerStory}
        onOpenDrawer={drawerOpenDrawer}
        onOptimizeUserStory={drawerOptimizeStory}
        onApproveAndMerge={drawerApproveStory}
        onRequestChanges={drawerRequestChanges}
        onReject={drawerRejectStory}
        reviewDiffEmpty={
          drawerUserStory ? reviewDiffEmpty(drawerUserStory) : false
        }
        onStopAgent={drawerStopAgent}
        onUndoUserStoryComment={drawerUndoComment}
        setupInitializing={backlog.storySetupInitializing(drawerUserStory)}
        titleGenerating={
          drawerUserStory ? storyTitleGenerating(drawerUserStory) : false
        }
      />
      <UserStoryPreviewWarmup userStories={backlog.stories} />
      <HostDependenciesDialog {...rotation.hostDependenciesDialog} />
    </div>
  )
}

function useLatestCallback<Arguments extends unknown[], Result>(
  callback: (...arguments_: Arguments) => Result
) {
  const callbackRef = React.useRef(callback)
  React.useEffect(() => {
    callbackRef.current = callback
  }, [callback])
  return React.useCallback(
    (...arguments_: Arguments) => callbackRef.current(...arguments_),
    []
  )
}

function approveAndMergeValidationError(
  story: UserStory,
  auth: ReturnType<typeof useCloudAuth>,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string | undefined,
  model: unknown
) {
  if (!story.worktree) return "This user story has no active worktree."
  if (!story.branch) return "This user story has no feature branch."
  if (!repositoryRoot) return "Unable to resolve the active project."
  if (auth.status !== "authenticated")
    return "Reconnect the provider before approving the merge."
  if (!model) return "Select a model before approving the merge."
  if (!platform.agent?.approveAndMerge)
    return "Desktop agent runtime is not available."
}

function optimizeUserStoryValidationError(
  summary: string,
  auth: ReturnType<typeof useCloudAuth>,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string | undefined,
  model: unknown
) {
  if (!summary.trim()) return "Write a user story before optimizing it."
  if (!repositoryRoot) return "Unable to resolve the active project."
  if (auth.status !== "authenticated")
    return "Reconnect the provider before optimizing the user story."
  if (!model) return "Select a model before optimizing the user story."
  if (!platform.agent?.promptOptimizer)
    return "Desktop agent runtime is not available."
}

type OptimizeUserStoryPromptRequest = {
  input: {
    summary: string
    title: string
  }
  auth: ReturnType<typeof useCloudAuth>
  platform: ReturnType<typeof usePlatform>
  projectPath?: string
  model: ReturnType<typeof useModelSelection>["currentModel"]
  reasoningEffort: ReturnType<typeof useModelSelection>["currentVariant"]
}

async function optimizeUserStoryPrompt(
  request: OptimizeUserStoryPromptRequest
) {
  const validationError = optimizeUserStoryValidationError(
    request.input.summary,
    request.auth,
    request.platform,
    request.projectPath,
    request.model
  )
  if (validationError) throw optimizationValidationError(validationError)
  const toastId = "user-story-prompt-optimizer"
  toast.loading("Optimizing user story", {
    id: toastId,
    position: "bottom-right",
  })
  try {
    const result = await runPromptOptimizer(request)
    toast.success("User story optimized", {
      id: toastId,
      position: "bottom-right",
    })
    return result
  } catch (error) {
    toast.error("User story optimization failed", {
      description: errorMessage(error),
      id: toastId,
      position: "bottom-right",
    })
    throw error
  }
}

function optimizationValidationError(message: string) {
  toast.error("Unable to optimize user story", {
    description: message,
    position: "bottom-right",
  })
  return new Error(message)
}

async function runPromptOptimizer(request: OptimizeUserStoryPromptRequest) {
  const result =
    await request.platform.agent!.promptOptimizer.optimizeUserStory({
      apiConnection: request.auth.apiConnection,
      providerId: request.model!.provider.id,
      modelId: request.model!.id,
      credentialLabel: request.model!.credentialLabel,
      reasoningEffort: request.reasoningEffort,
      prompt: request.input.summary,
      title: request.input.title,
      cwd: request.projectPath!,
      workspaceRoot: request.projectPath!,
    })
  return result.markdown
}

type CheckInitializationImpactInput = {
  auth: ReturnType<typeof useCloudAuth>
  platform: ReturnType<typeof usePlatform>
  projectId: string
  providerId: string
  modelId: string
  credentialLabel?: string
  reasoningEffort?: ReasoningSelection
  repositoryRoot: string
  baseCommit: string
  mergeCommit: string
  previewRepairCandidate?: ProjectPreviewRepairCandidate
}

async function checkProjectInitializationImpact(
  input: CheckInitializationImpactInput
) {
  const toastId = `project-initialization-impact-${input.mergeCommit}`
  toast.loading("Checking initialization impact", {
    id: toastId,
    position: "bottom-right",
  })
  try {
    const result = await assessAndRepairProjectInitializationImpact({
      apiConnection: input.auth.apiConnection,
      platform: input.platform,
      projectId: input.projectId,
      providerId: input.providerId,
      modelId: input.modelId,
      credentialLabel: input.credentialLabel,
      reasoningEffort: input.reasoningEffort,
      repositoryRoot: input.repositoryRoot,
      baseCommit: input.baseCommit,
      mergeCommit: input.mergeCommit,
      previewRepairCandidate: input.previewRepairCandidate,
    })
    showInitializationImpactResult(toastId, result)
  } catch (error) {
    toast.error("Story merged, initialization check failed", {
      description: errorMessage(error),
      id: toastId,
      position: "bottom-right",
    })
  }
}

function showInitializationImpactResult(
  toastId: string,
  result: ProjectInitializationImpactRepairResult | undefined
) {
  const options = { id: toastId, position: "bottom-right" as const }
  if (!result) return void toast.dismiss(toastId)
  if (result.repair?.classification === "repairable_initialization") {
    toast.success("Initialization successfully updated", {
      ...options,
      description:
        "Your project initialization is up to date with the merged changes.",
    })
    return
  }
  if (showUnchangedInitializationImpactResult(toastId, result)) return
  if (result.assessment.classification === "initialization_update_required") {
    toast.error("Story merged, initialization update failed", {
      ...options,
      description: result.repair?.reason ?? result.assessment.reason,
    })
    return
  }
  toast.dismiss(toastId)
}

function showUnchangedInitializationImpactResult(
  toastId: string,
  result: ProjectInitializationImpactRepairResult
) {
  const classification =
    result.repair?.classification ?? result.assessment.classification
  if (
    classification !== "unknown" &&
    classification !== "initialization_still_valid"
  ) {
    return false
  }
  const unconfirmed = classification === "unknown"
  toast.info(
    unconfirmed
      ? "Initialization kept unchanged"
      : "Initialization already up to date",
    {
      description: unconfirmed
        ? "The review did not confirm a needed update. Your current configuration was kept."
        : "Your current configuration is compatible with the merged changes.",
      id: toastId,
      position: "bottom-right",
    }
  )
  return true
}

async function inactiveStoryCleanup(
  story: UserStory,
  input: UserStoryUpdate,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string | undefined
): Promise<UserStoryUpdate> {
  const nextStatus = input.status ?? story.status
  if (!leavesRuntimeStatus(story.status, nextStatus)) return {}
  await stopStoryRuntime(story, platform)
  await removeStoryWorktree(story, platform, repositoryRoot)
  return inactiveStoryFields()
}

function asyncInactiveStoryCleanup(story: UserStory, input: UserStoryUpdate) {
  const nextStatus = input.status ?? story.status
  return (
    nextStatus === "discarded" && leavesRuntimeStatus(story.status, nextStatus)
  )
}

async function cleanupInactiveStory(
  story: UserStory,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string | undefined,
  backlog: ReturnType<typeof useBacklogStore>
) {
  backlog.setStoryCleanup(story, true)
  try {
    await stopStoryRuntime(story, platform)
    await removeStoryWorktree(story, platform, repositoryRoot)
    await backlog.update(story, inactiveStoryFields())
  } catch (error) {
    toast.error("Discarded story cleanup failed", {
      description: errorMessage(error),
      position: "bottom-right",
    })
  } finally {
    backlog.setStoryCleanup(story, false)
  }
}

const runtimeStatuses = new Set<BacklogColumnId>(["in-progress", "in-review"])

function leavesRuntimeStatus(
  currentStatus: BacklogColumnId,
  nextStatus: BacklogColumnId
) {
  return runtimeStatuses.has(currentStatus) && !runtimeStatuses.has(nextStatus)
}

function notifyStoriesMovedToReview(
  stories: UserStory[],
  previousStatuses: Map<string, BacklogColumnId> | undefined,
  platform: ReturnType<typeof usePlatform>
) {
  if (!previousStatuses) return
  for (const story of stories) {
    const previousStatus = previousStatuses.get(story.id)
    if (previousStatus === undefined || previousStatus === "in-review") continue
    if (story.status !== "in-review") continue
    void showSystemNotification(platform, {
      body: story.title,
      target: { pathname: "/backlog", storyId: story.id, tab: "diff" },
      title: "User story ready for review",
    })
  }
}

function storyStatusMap(stories: UserStory[]) {
  return new Map(stories.map((story) => [story.id, story.status]))
}

async function stopStoryRuntime(
  story: UserStory,
  platform: ReturnType<typeof usePlatform>
) {
  await Promise.all([
    abortStoryAgent(story, platform),
    stopStoryProjectSetup(story, platform),
    stopManagedCloudPreview(platform, story.id),
  ])
}

async function cleanupMergedStory(
  story: UserStory,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string | undefined
) {
  try {
    const [, projectSetupStopped] = await Promise.all([
      measurePerformanceOperation("agent.transition.cleanup.agent_abort", () =>
        abortStoryAgent(story, platform)
      ),
      measurePerformanceOperation("agent.transition.cleanup.runtime_stop", () =>
        stopStoryProjectSetup(story, platform)
      ),
      measurePerformanceOperation(
        "agent.transition.cleanup.cloud_preview_stop",
        () => stopManagedCloudPreview(platform, story.id)
      ),
    ])
    await measurePerformanceOperation(
      "agent.transition.cleanup.worktree_remove",
      () =>
        removeStoryWorktree(
          story,
          platform,
          repositoryRoot,
          projectSetupStopped
        )
    )
  } catch (error) {
    toast.error("Merged story cleanup failed", {
      description: errorMessage(error),
      position: "bottom-right",
    })
  }
}

async function runPostMergeTasks(
  story: UserStory,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string,
  initializationImpactInput: CheckInitializationImpactInput
) {
  const previewRepairCandidate = await storyPreviewRepairCandidate(
    story,
    platform
  )
  await cleanupMergedStory(story, platform, repositoryRoot)
  await afterRendererPaint()
  await measurePerformanceOperation(
    "agent.transition.initialization_impact",
    () =>
      checkProjectInitializationImpact({
        ...initializationImpactInput,
        previewRepairCandidate,
      })
  )
}

async function storyPreviewRepairCandidate(
  story: UserStory,
  platform: ReturnType<typeof usePlatform>
) {
  if (!story.worktree || !platform.workspace) return undefined
  try {
    const content = await platform.workspace.readFile({
      root: story.worktree,
      path: ".blame/initialization/preview-repair.json",
    })
    return parseProjectPreviewRepairCandidate(content)
  } catch {
    return undefined
  }
}

function replaceStoryAfterUndo(
  story: UserStory,
  storiesRef: { current: UserStory[] },
  setDrawerTarget: React.Dispatch<
    React.SetStateAction<DrawerTarget | undefined>
  >
) {
  storiesRef.current = storiesRef.current.map((currentStory) =>
    currentStory.id === story.id ? story : currentStory
  )
  setDrawerTarget((current) =>
    current?.userStory?.id === story.id
      ? { ...current, userStory: story }
      : current
  )
}

async function restoreStoryCheckpoint(
  platform: Platform,
  story: UserStory,
  sessionId: string | null | undefined,
  checkpointRunCount: number
) {
  if (!platform.agent)
    throw new Error("Desktop agent runtime is not available.")
  if (!sessionId) throw new Error("This message has no Cline session.")
  if (!story.worktree)
    throw new Error("This user story has no active worktree.")
  return platform.agent.sessions.restoreCheckpoint({
    checkpointRunCount,
    cwd: story.worktree,
    restore: {
      messages: true,
      omitCheckpointMessageFromSession: true,
      workspace: true,
    },
    sessionId,
  })
}

function detailedStory(
  story: UserStory,
  backlog: ReturnType<typeof useBacklogStore>
) {
  if (backlog.storyDetailsLoaded(story)) return Promise.resolve(story)
  return backlog.loadDetail(story)
}

function detailedStoryForAction(
  story: UserStory,
  action: BacklogAction,
  backlog: ReturnType<typeof useBacklogStore>
) {
  if (!storyActionRequiresDetail(action)) return Promise.resolve(story)
  return detailedStory(story, backlog)
}

function storyActionRequiresDetail(action: BacklogAction) {
  return (
    action === "Approve & Merge" ||
    action === "Use Context" ||
    action === "Delete Permanently"
  )
}

function statusPipDrawerTarget(
  story: UserStory,
  request: BacklogStatusPipRequest
): DrawerTarget {
  return {
    userStory: story,
    mode:
      story.status === "backlog" || story.status === "discarded"
        ? "edit"
        : "view",
    focusComment: request.drawer?.focusComment,
    initialDevelopmentTab: request.drawer?.initialDevelopmentTab,
    initialTab: request.drawer?.initialTab ?? "user-story",
  }
}

function reportAgentPersistenceError(error: unknown) {
  console.error("Failed to persist agent update.", error)
}

function clearStoryAgentStream(story: UserStory, run?: UserStoryAgentRun) {
  const sessionId = run?.clineSessionId ?? story.clineSessionId
  if (run && sessionId) agentStreamStore.clear({ runId: run.id, sessionId })
}

function terminalStoryAgentStatus(status: UserStoryAgentRunUpdate["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function reportStatusPipRequestError(error: unknown) {
  toast.error("Unable to run picture in picture action", {
    description:
      error instanceof Error ? error.message : "An unexpected error occurred.",
    position: "bottom-right",
  })
}

function clineLogPath(worktree: string, sessionId: string) {
  return `${worktree}/.blame/logs/cline-${sessionId}.log`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function resumeAgentFeedback(story: UserStory, diffSummary: string) {
  const details = [
    story.agentSessionSummary
      ? `Previous session summary:\n${story.agentSessionSummary}`
      : "",
    story.agentLastError ? `Previous agent error: ${story.agentLastError}` : "",
    story.agentLastEvent ? `Last recorded event: ${story.agentLastEvent}` : "",
    diffSummary,
  ].filter(Boolean)
  return [
    "Resume the implementation from the existing worktree.",
    "Inspect the current git diff first, keep the useful existing changes, and continue until the story is ready for review.",
    ...details,
  ].join("\n")
}

async function currentDiffSummary(story: UserStory, platform: Platform) {
  if (!story.worktree || !platform.workspace) return ""
  try {
    const diff = await platform.workspace.gitDiff({ root: story.worktree })
    return diffSummary(diff)
  } catch {
    return ""
  }
}

function diffSummary(diff: string) {
  const files = Array.from(diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm))
    .map((match) => match[2])
    .filter(Boolean)
    .slice(0, 20)
  if (files.length === 0) return "Current git diff: no local changes."
  return `Current git diff files: ${files.join(", ")}.`
}

