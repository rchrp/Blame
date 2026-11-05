import type { AgentEvent } from "@blame/agent-runtime"
import * as React from "react"
import { toast } from "sonner"

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
  closeStoryRunStreams,
  forgetRunStream,
  registerRunStream,
  runStreamOpen,
} from "@/components/backlog/data/agent-run-streams"
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
import type {
  UserStory,
  UserStoryAgentRun,
  UserStoryAgentRunUpdate,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import {
  agentAuthenticationErrorKey,
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
  runFlowState,
} from "@/components/backlog/data/user-story-agent-updates"
import type { Platform } from "@/context/platform"
import { createDebouncedUpdateQueue } from "@/lib/debounced-update-queue"
import { recordPerformanceEvent } from "@/lib/performance-diagnostics"
import {
  notifyCommentResponseCompleted,
  reportAgentPersistenceError,
  runningAgentRunsForStory,
} from "./backlog-rotation-helpers"
import { activeStory } from "./story-runtime-state"

const agentEventPersistDelayMs = 1_500
const terminalAgentRetryIntervalMs = 60_000
const authToastId = "backlog-agent-auth"

type StoryAgentStream = {
  backlog: ReturnType<typeof useBacklogStore>
  platform: Platform
  storiesRef: { current: UserStory[] }
  updateStory(
    story: UserStory,
    input: UserStoryUpdate,
    options?: { cleanup?: boolean }
  ): Promise<UserStory>
  updateStoryLocal(
    story: UserStory,
    input: UserStoryUpdate,
    run?: UserStoryAgentRun,
    runInput?: UserStoryAgentRunUpdate
  ): UserStory
}

export type StoryAgentStreamControls = ReturnType<typeof useStoryAgentStream>

// Follows every story agent's event stream, whatever started it (the Agent
// Queue, a resume, a comment, or a run found running after a restart), and
// saves what it streams: activity is batched, terminal updates go through
// an outbox that is replayed until they are saved.
export function useStoryAgentStream({
  backlog,
  platform,
  storiesRef,
  updateStory,
  updateStoryLocal,
}: StoryAgentStream) {
  const pendingAgentUpdates = React.useRef(
    createDebouncedUpdateQueue<QueuedAgentUpdate>(agentEventPersistDelayMs)
  )
  const agentStreamClosers = React.useRef(new Map<string, () => void>())
  const retryingTerminalAgentUpdates = React.useRef(false)
  // Runs paused for an expired provider token: later events are ignored.
  const expiredAuthenticationRuns = React.useRef(new Set<string>())
  const authenticationExpiredListeners = React.useRef(new Set<() => void>())
  const backlogRef = React.useRef(backlog)
  const persistTerminalAgentUpdateRef = React.useRef<
    (story: UserStory, update: QueuedAgentUpdate) => Promise<unknown>
  >(async () => undefined)

  React.useEffect(() => {
    backlogRef.current = backlog
  }, [backlog])

  React.useEffect(
    () => () => {
      pendingAgentUpdates.current.clear()
      agentStreamClosers.current.forEach((close) => close())
      agentStreamClosers.current.clear()
    },
    []
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
    [backlog, storiesRef, updateStory]
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
      // Failures are reported, and terminal ones replayed, by the call.
      void persistPreparedAgentUpdate(
        nextStory,
        run,
        storyInput,
        runInput,
        immediate
      ).catch(() => undefined)
    },
    [persistPreparedAgentUpdate, updateStoryLocal]
  )
  // Once per run: the toast, and the listeners (the Agent Queue waits).
  const reportExpiredAuthentication = React.useCallback(
    (story: UserStory, message: string, run?: UserStoryAgentRun) => {
      expiredAuthenticationRuns.current.add(
        agentAuthenticationErrorKey(story, run)
      )
      authenticationExpiredListeners.current.forEach((listener) => listener())
      toast.error("Agent authentication expired", {
        description: `${message} Reconnect the selected provider, then restart the story.`,
        id: `${authToastId}-${story.id}`,
        position: "bottom-right",
      })
    },
    []
  )
  const onAuthenticationExpired = React.useCallback((listener: () => void) => {
    authenticationExpiredListeners.current.add(listener)
    return () => {
      authenticationExpiredListeners.current.delete(listener)
    }
  }, [])
  const persistAgentEvent = React.useCallback(
    async (
      story: UserStory,
      run: UserStoryAgentRun | undefined,
      event: AgentEvent,
      prepared?: AgentStreamSnapshotPersistence
    ) => {
      const currentStory = activeStory(story, storiesRef.current)
      const text = agentEventText(event)
      const authenticationExpired = expiredAuthenticationToken(text)
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
        !authenticationExpired
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
      if (
        expiredAuthenticationRuns.current.has(
          agentAuthenticationErrorKey(story, run)
        )
      )
        return
      if (authenticationExpired) reportExpiredAuthentication(story, text, run)
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
      reportExpiredAuthentication,
      storiesRef,
      updateStoryLocal,
    ]
  )
  const subscribeStoryAgentEvents = React.useCallback(
    (
      story: UserStory,
      run: UserStoryAgentRun,
      sessionId: string,
      executionId = run.executionId ?? undefined
    ) => {
      // One stream per run: a start and the effect below may both ask.
      if (runStreamOpen(run.id)) return
      // The run this one replaces stops listening.
      closeStoryRunStreams(story.id, run.id)
      const coordinator = new AgentStreamCoordinator({
        executionId: executionId ?? run.id,
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
      let authenticationFailed = false
      let unsubscribe: () => void = () => undefined
      const close = () => {
        unsubscribe()
        agentStreamClosers.current.delete(run.id)
        forgetRunStream(run.id, close)
        void coordinator.disconnect().catch(reportAgentPersistenceError)
      }
      registerRunStream(run.id, story.id, close, () => coordinator.flush())
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

  // Runs the backlog shows running are followed: after a restart, or while
  // their start is still subscribing.
  React.useEffect(() => {
    if (!platform.agent || backlog.loading) return
    backlog.stories.forEach((story) => {
      runningAgentRunsForStory(story).forEach((run) => {
        const sessionId = run.clineSessionId ?? story.clineSessionId
        if (!sessionId || runStreamOpen(run.id)) return
        subscribeStoryAgentEvents(story, run, sessionId)
      })
    })
  }, [
    backlog.loading,
    backlog.stories,
    platform.agent,
    subscribeStoryAgentEvents,
  ])

  return {
    onAuthenticationExpired,
    persistAgentEvent,
    subscribeStoryAgentEvents,
  }
}

function clearStoryAgentStream(story: UserStory, run?: UserStoryAgentRun) {
  const sessionId = run?.clineSessionId ?? story.clineSessionId
  if (run && sessionId) agentStreamStore.clear({ runId: run.id, sessionId })
}

function terminalStoryAgentStatus(status: UserStoryAgentRunUpdate["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled"
}
