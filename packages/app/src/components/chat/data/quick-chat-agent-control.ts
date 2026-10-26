import type {
  QuickChat,
  QuickChatAgentRun,
  QuickChatAgentRunFinalization,
  QuickChatUpdate,
} from "./quick-chat-data.ts"
import { agentPersistenceEvent } from "../../backlog/data/agent-stream-coordinator.ts"
import { settleStoryRunStreams } from "../../backlog/data/agent-run-streams.ts"

export function quickChatStreamKey(chatId: string) {
  return `chat:${chatId}`
}

export function quickChatAgentRunning(chat: QuickChat | undefined) {
  if (!chat || chat.agentStatus === "Paused") return false
  const status = chat.agentRuns?.at(-1)?.status
  return (
    chat.agentStatus === "Running" ||
    status === "running" ||
    status === "pending"
  )
}

// Starting and stopping are short transitions, separate from the response's
// lifetime. A stop waits for startup to expose its session before aborting it.
export class QuickChatAgentOperations {
  private starts = new Map<string, Promise<unknown>>()
  private stops = new Map<string, Promise<unknown>>()
  private deleting = new Set<string>()
  private listeners = new Set<() => void>()
  private busy: ReadonlySet<string> = new Set()

  snapshot = () => this.busy
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  preventStarts(chatId: string) {
    this.deleting.add(chatId)
    this.emit()
  }

  allowStarts(chatId: string) {
    this.deleting.delete(chatId)
    this.emit()
  }

  start<T>(chatId: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(chatId)) {
      return Promise.reject(
        new Error("This chat is still starting or stopping. Please try again.")
      )
    }
    const pending = Promise.resolve()
      .then(action)
      .finally(() => {
        this.starts.delete(chatId)
        this.emit()
      })
    this.starts.set(chatId, pending)
    this.emit()
    return pending
  }

  stop<T>(chatId: string, action: () => Promise<T>): Promise<T> {
    const existing = this.stops.get(chatId)
    if (existing) return existing as Promise<T>
    const pending = Promise.resolve(this.starts.get(chatId))
      .catch(() => undefined)
      .then(action)
      .finally(() => {
        this.stops.delete(chatId)
        this.emit()
      })
    this.stops.set(chatId, pending)
    this.emit()
    return pending
  }

  private emit() {
    this.busy = new Set([
      ...this.starts.keys(),
      ...this.stops.keys(),
      ...this.deleting,
    ])
    for (const listener of this.listeners) listener()
  }
}

type StopQuickChatDependencies = {
  abort?: (sessionId: string) => Promise<void>
  loadDetail(chat: Pick<QuickChat, "id">): Promise<QuickChat>
  finalizeAgentRun(
    chat: QuickChat,
    run: QuickChatAgentRun,
    input: QuickChatAgentRunFinalization
  ): Promise<QuickChat>
  update(chat: QuickChat, input: QuickChatUpdate): Promise<QuickChat>
}

// Works from the sidebar as well as the chat page, including after the page
// has unmounted. Flush the stream before allocating the terminal sequence.
export async function stopQuickChatAgent(
  chat: Pick<QuickChat, "id">,
  dependencies: StopQuickChatDependencies
) {
  const current = await dependencies.loadDetail(chat)
  const running =
    current.agentRuns?.filter(
      (run) => run.status === "running" || run.status === "pending"
    ) ?? []
  const sessionIds = new Set(
    running
      .map((run) => run.clineSessionId ?? current.clineSessionId)
      .filter((id): id is string => Boolean(id))
  )
  if (current.agentStatus === "Running" && current.clineSessionId)
    sessionIds.add(current.clineSessionId)
  const active = current.agentStatus === "Running" || running.length > 0
  if (active && !sessionIds.size)
    throw new Error(
      "The agent session is not available yet. Please try stopping it again."
    )
  if (sessionIds.size && !dependencies.abort)
    throw new Error("Desktop agent runtime is not available.")
  for (const sessionId of sessionIds) await dependencies.abort!(sessionId)
  await settleStoryRunStreams(quickChatStreamKey(chat.id))
  if (!active) return current

  let stopped = await dependencies.loadDetail(chat)
  for (const run of stopped.agentRuns ?? []) {
    if (run.status !== "running" && run.status !== "pending") continue
    const completedAt = new Date().toISOString()
    stopped = await dependencies.finalizeAgentRun(stopped, run, {
      activities: [],
      agentLastError: null,
      agentLastEvent: "Agent stopped.",
      agentStatus: "Paused",
      completedAt,
      finalResponse: run.finalResponse || "Agent stopped.",
      persistenceEvent: agentPersistenceEvent(
        {
          createdAt: completedAt,
          payload: { reason: "aborted" },
          type: "done",
        },
        {
          executionId: run.executionId ?? run.id,
          lastSequenceNumber: run.lastSequenceNumber,
          runId: run.id,
          sessionId: run.clineSessionId ?? stopped.clineSessionId ?? run.id,
        }
      ),
      status: "cancelled",
    })
  }
  // The runtime may already have emitted its own terminal event. Keep a
  // deliberate stop paused so waiting messages don't automatically restart it.
  return dependencies.update(stopped, {
    agentLastError: null,
    agentLastEvent: "Agent stopped.",
    agentStatus: "Paused",
  })
}
