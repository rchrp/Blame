import type { AgentEvent } from "@blame/agent-runtime"
import * as React from "react"

import {
  agentEventText,
  completedAgentRun,
  shouldPersistAgentEvent,
  terminalAgentRunEvent,
} from "@/components/backlog/data/agent-flow"
import { subscribeAgentEvents } from "@/components/backlog/data/agent-event-stream"
import {
  forgetRunStream,
  registerRunStream,
} from "@/components/backlog/data/agent-run-streams"
import {
  pendingAgentRunSnapshots,
  persistAgentSnapshot,
} from "@/components/backlog/data/agent-snapshot-outbox"
import {
  agentPersistenceEvent,
  AgentStreamCoordinator,
  type AgentStreamSnapshotPersistence,
} from "@/components/backlog/data/agent-stream-coordinator"
import { agentStreamStore } from "@/components/backlog/data/agent-stream-store"
import { captureAgentRunDiffEndRef } from "@/components/chat/agent-run-diffs"
import { quickChatStreamKey } from "@/components/chat/data/quick-chat-agent-control"
import {
  definedQuickChatUpdate,
  immediateQuickChatAgentEvent,
  pendingQuickChatAgentUpdate,
  quickChatAgentEventUpdate,
  quickChatAgentMetadataUpdate,
  quickChatAgentRunEventUpdate,
  quickChatAgentRunMetadataUpdate,
  quickChatExpiredAuthenticationToken,
  type QueuedQuickChatAgentUpdate,
} from "@/components/chat/data/quick-chat-agent-flow"
import type {
  QuickChat,
  QuickChatAgentRun,
  QuickChatAgentRunFinalization,
  QuickChatAgentRunUpdate,
  QuickChatUpdate,
} from "@/components/chat/data/quick-chat-data"
import type { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import type { Platform } from "@/context/platform"
import { createDebouncedUpdateQueue } from "@/lib/debounced-update-queue"
import { showSystemNotification } from "@/lib/system-notifications"
import {
  quickChatAgentFinalization,
  quickChatTerminalPersistenceEvent,
  reportAgentPersistenceError,
  showExpiredAuthenticationToast,
} from "./quick-chat-helpers"

const agentEventPersistDelayMs = 1_500

type QuickChatStore = ReturnType<typeof useQuickChatStore>

type QuickChatAgentStreamInput = {
  chatsRef: React.RefObject<QuickChat[]>
  platform: Platform
  quickChatsRef: React.RefObject<QuickChatStore>
}

// Follows quick chat agents' event streams and saves what they stream:
// activity is batched, terminal updates go through the snapshot outbox. It
// lives as long as the app, so a chat keeps recording while its page is
// closed or another project is open.
export function useQuickChatAgentStream({
  chatsRef,
  platform,
  quickChatsRef,
}: QuickChatAgentStreamInput) {
  const pendingAgentUpdates = React.useRef(
    createDebouncedUpdateQueue<QueuedQuickChatAgentUpdate>(
      agentEventPersistDelayMs
    )
  )
  const agentEventUnsubscribers = React.useRef(new Map<string, () => void>())
  const agentStreamCoordinators = React.useRef(
    new Map<string, AgentStreamCoordinator>()
  )
  const store = () => quickChatsRef.current

  React.useEffect(() => {
    const updates = pendingAgentUpdates.current
    const unsubscribers = agentEventUnsubscribers.current
    const coordinators = agentStreamCoordinators.current
    return () => {
      updates.clear()
      unsubscribers.forEach((unsubscribe) => unsubscribe())
      unsubscribers.clear()
      coordinators.forEach((coordinator) => {
        void coordinator.disconnect().catch(reportAgentPersistenceError)
      })
      coordinators.clear()
    }
  }, [])

  function replaceChatRef(chat: QuickChat) {
    const exists = chatsRef.current.some((item) => item.id === chat.id)
    chatsRef.current = exists
      ? chatsRef.current.map((item) => (item.id === chat.id ? chat : item))
      : [chat, ...chatsRef.current]
  }

  function currentChat(chat: QuickChat) {
    return chatsRef.current.find((item) => item.id === chat.id) ?? chat
  }

  function updateChatLocal(chat: QuickChat, input: QuickChatUpdate) {
    const current = currentChat(chat)
    const next = { ...current, ...definedQuickChatUpdate(input) } as QuickChat
    replaceChatRef(next)
    store().updateLocal(current, input)
    return next
  }

  async function persistQueuedAgentUpdate(
    chat: QuickChat,
    update: QueuedQuickChatAgentUpdate
  ) {
    let nextChat = currentChat(chat)
    const finalization = quickChatAgentFinalization(update)
    if (update.run && finalization) {
      const event =
        finalization.persistenceEvent ??
        quickChatTerminalPersistenceEvent(nextChat, update.run, finalization)
      finalization.persistenceEvent = event
      const finalized = await persistAgentSnapshot(
        window.localStorage,
        {
          event,
          messageId: update.activities.at(-1)?.id ?? "message-final",
          projectId: nextChat.projectId,
          runId: update.run.id,
          targetId: nextChat.id,
          targetType: "quick-chat",
          update: finalization,
        },
        (snapshot) =>
          store().finalizeAgentRun(
            nextChat,
            update.run!,
            snapshot.update as QuickChatAgentRunFinalization
          )
      )
      replaceChatRef(finalized)
      return finalized
    }
    const metadata = quickChatAgentMetadataUpdate(update.input)
    if (Object.keys(definedQuickChatUpdate(metadata)).length) {
      nextChat = await store().update(nextChat, metadata)
      replaceChatRef(nextChat)
    }
    if (update.activities.length) {
      if (update.run) {
        await store().updateAgentRun(nextChat, update.run, {
          agentActivityUpdates: update.activities,
        })
      } else {
        nextChat = await store().update(currentChat(nextChat), {
          agentActivityUpdates: update.activities,
        })
        replaceChatRef(nextChat)
      }
    }
    if (update.run) await persistAgentRunMetadata(nextChat, update)
    return nextChat
  }

  async function persistAgentRunMetadata(
    chat: QuickChat,
    update: QueuedQuickChatAgentUpdate
  ) {
    if (!update.run) return
    const metadata = quickChatAgentRunMetadataUpdate(update.runInput)
    if (!Object.keys(definedQuickChatUpdate(metadata)).length) return
    await store().updateAgentRun(chat, update.run, metadata)
  }

  function queueAgentUpdate(
    chat: QuickChat,
    run: QuickChatAgentRun | undefined,
    input: QuickChatUpdate,
    runInput: QuickChatAgentRunUpdate
  ) {
    const pending = pendingAgentUpdates.current.get(chat.id)
    const update = pendingQuickChatAgentUpdate(pending, input, run, runInput)
    pendingAgentUpdates.current.schedule(chat.id, update, (queued) => {
      void persistQueuedAgentUpdate(chat, queued).catch(
        reportAgentPersistenceError
      )
    })
  }

  function flushAgentUpdate(
    chat: QuickChat,
    run: QuickChatAgentRun | undefined,
    input: QuickChatUpdate,
    runInput: QuickChatAgentRunUpdate
  ) {
    const pending = pendingAgentUpdates.current.take(chat.id)
    return persistQueuedAgentUpdate(
      chat,
      pendingQuickChatAgentUpdate(pending, input, run, runInput)
    )
  }

  function persistAgentUpdate(
    chat: QuickChat,
    run: QuickChatAgentRun | undefined,
    input: QuickChatUpdate,
    runInput: QuickChatAgentRunUpdate,
    immediate: boolean
  ) {
    const nextChat = updateChatLocal(chat, input)
    if (run) store().updateAgentRunLocal(nextChat, run, runInput)
    if (immediate) {
      return flushAgentUpdate(nextChat, run, input, runInput).catch((error) => {
        reportAgentPersistenceError(error)
        throw error
      })
    }
    queueAgentUpdate(nextChat, run, input, runInput)
    return Promise.resolve(nextChat)
  }

  async function persistAgentEvent(
    chat: QuickChat,
    run: QuickChatAgentRun | undefined,
    event: AgentEvent,
    prepared?: AgentStreamSnapshotPersistence
  ) {
    const current = currentChat(chat)
    const update = quickChatAgentEventUpdate(current, event, prepared?.update)
    if (!shouldPersistAgentEvent(event, update)) return
    const text = agentEventText(event)
    const runInput = quickChatAgentRunEventUpdate(update, event, text)
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
            current.clineSessionId ??
            run.id,
        })
    }
    if (
      prepared &&
      run &&
      !terminalAgentRunEvent(event) &&
      !quickChatExpiredAuthenticationToken(text)
    ) {
      return persistQuickChatStreamSnapshot(current, run, runInput, prepared)
    }
    if (run && terminalAgentRunEvent(event) && !run.diffEndRef) {
      runInput.diffEndRef = await captureAgentRunDiffEndRef({
        id: run.id,
        platform,
        root: current.workspace,
      })
    }
    if (completedAgentRun(event)) notifyQuickChatResponseCompleted(current)
    return persistAgentUpdate(
      current,
      run,
      update,
      runInput,
      immediateQuickChatAgentEvent(event)
    )
  }

  function persistQuickChatStreamSnapshot(
    chat: QuickChat,
    run: QuickChatAgentRun,
    runInput: QuickChatAgentRunUpdate,
    prepared: AgentStreamSnapshotPersistence
  ) {
    return persistAgentSnapshot(
      window.localStorage,
      {
        event: prepared.persistenceEvent,
        messageId: prepared.update.agentActivity?.id ?? prepared.event.type,
        projectId: chat.projectId,
        runId: run.id,
        targetId: chat.id,
        targetType: "quick-chat",
        update: runInput,
      },
      (snapshot) =>
        store().updateAgentRun(
          chat,
          run,
          snapshot.update as QuickChatAgentRunUpdate
        )
    )
  }

  function notifyQuickChatResponseCompleted(chat: QuickChat) {
    void showSystemNotification(platform, {
      body: chat.title,
      target: { pathname: "/chat", chatId: chat.id },
      title: "Agent response ready",
    })
  }

  function subscribe(
    chat: QuickChat,
    run: QuickChatAgentRun,
    sessionId: string
  ) {
    let authenticationFailed = false
    unsubscribeSession(sessionId)
    const coordinator = new AgentStreamCoordinator({
      executionId: run.executionId ?? run.id,
      initialState: {
        agentActivities: run.activities ?? chat.agentActivities,
        agentFinalResponse: run.finalResponse ?? chat.agentFinalResponse,
        agentSessionSummary: run.sessionSummary ?? chat.agentSessionSummary,
        agentUsage: run.usage ?? chat.agentUsage,
      },
      lastSequenceNumber: run.lastSequenceNumber,
      onError: reportAgentPersistenceError,
      persist: (snapshot) =>
        persistAgentEvent(chat, run, snapshot.event, snapshot),
      runId: run.id,
      recoveredSnapshots: pendingAgentRunSnapshots(
        window.localStorage,
        chat.projectId,
        "quick-chat",
        run.id
      ),
      sessionId,
    })
    agentStreamCoordinators.current.set(sessionId, coordinator)
    const unsubscribeEvents = subscribeAgentEvents(
      platform,
      sessionId,
      (event) => {
        if (authenticationFailed) return
        const text = agentEventText(event)
        authenticationFailed = quickChatExpiredAuthenticationToken(text)
        if (authenticationFailed) showExpiredAuthenticationToast(text)
        const persisted = terminalAgentRunEvent(event)
          ? coordinator.terminate(event)
          : coordinator.push(event)
        if (authenticationFailed || immediateQuickChatAgentEvent(event)) {
          void settle(sessionId, persisted, unsubscribe).catch(
            reportAgentPersistenceError
          )
        }
      },
      run.executionId ?? undefined,
      run.lastSequenceNumber ?? 0
    )
    const unsubscribe = () => {
      forgetRunStream(run.id, close)
      unsubscribeEvents()
    }
    const close = () => unsubscribeSession(sessionId, unsubscribe)
    registerRunStream(run.id, quickChatStreamKey(chat.id), close, async () => {
      await coordinator.disconnect()
      const pending = pendingAgentUpdates.current.take(chat.id)
      if (pending) await persistQueuedAgentUpdate(chat, pending)
    })
    agentEventUnsubscribers.current.set(sessionId, unsubscribe)
    return unsubscribe
  }

  function unsubscribeSession(sessionId: string, expected?: () => void) {
    const unsubscribe = agentEventUnsubscribers.current.get(sessionId)
    if (!unsubscribe || (expected && unsubscribe !== expected)) return
    agentEventUnsubscribers.current.delete(sessionId)
    const coordinator = agentStreamCoordinators.current.get(sessionId)
    agentStreamCoordinators.current.delete(sessionId)
    unsubscribe()
    void coordinator?.disconnect().catch(reportAgentPersistenceError)
  }

  function settle(
    sessionId: string,
    persisted: Promise<unknown>,
    expected?: () => void
  ) {
    expected ??= agentEventUnsubscribers.current.get(sessionId)
    return persisted.then(
      (result) => {
        unsubscribeSession(sessionId, expected)
        return result
      },
      (error) => {
        unsubscribeSession(sessionId, expected)
        throw error
      }
    )
  }

  // A late result from an aborted turn must not terminate its successor,
  // which may reuse exactly the same runtime session.
  function terminateWithError(
    sessionId: string,
    coordinator: AgentStreamCoordinator | undefined,
    message: string
  ) {
    if (
      !coordinator ||
      agentStreamCoordinators.current.get(sessionId) !== coordinator
    )
      return Promise.resolve()
    return settle(
      sessionId,
      coordinator.terminate({ payload: { message }, sessionId, type: "error" })
    )
  }

  function clearStream(chat: QuickChat, run: QuickChatAgentRun) {
    const sessionId = run.clineSessionId ?? chat.clineSessionId
    if (sessionId) agentStreamStore.clear({ runId: run.id, sessionId })
  }

  return {
    clearStream,
    coordinator: (sessionId: string) =>
      agentStreamCoordinators.current.get(sessionId),
    currentChat,
    persistAgentEvent,
    replaceChatRef,
    subscribe,
    terminateWithError,
    updateChatLocal,
  }
}
