import { quickChatAgentRunning } from "../../components/chat/data/quick-chat-agent-control.ts"
import type {
  QuickChat,
  QuickChatAgentRun,
} from "../../components/chat/data/quick-chat-data.ts"

type FollowState = {
  busy: ReadonlySet<string>
  detailsLoaded(chat: QuickChat): boolean
  followed(sessionId: string): boolean
}

// What the background runner does with the chats it knows: load the ones
// whose agent runs but whose turns are not known yet, and follow every
// running turn nobody follows. Chats starting or stopping are left alone.
export function quickChatBackgroundWork(
  chats: readonly QuickChat[],
  state: FollowState
) {
  const load: QuickChat[] = []
  const follow: Array<{
    chat: QuickChat
    run: QuickChatAgentRun
    sessionId: string
  }> = []
  for (const chat of chats) {
    if (state.busy.has(chat.id)) continue
    if (!state.detailsLoaded(chat)) {
      if (chat.agentStatus === "Running") load.push(chat)
      continue
    }
    for (const run of chat.agentRuns ?? []) {
      const sessionId = run.clineSessionId ?? chat.clineSessionId
      if (run.status !== "running" || !sessionId) continue
      if (!state.followed(sessionId)) follow.push({ chat, run, sessionId })
    }
  }
  return { follow, load }
}

// Chats whose queued messages can go out now: their agent is not working,
// starting, stopping or paused by the person.
export function quickChatsReadyForQueuedMessages(
  chats: readonly QuickChat[],
  waitingChatIds: Iterable<string>,
  busy: ReadonlySet<string>
) {
  const waiting = new Set(waitingChatIds)
  return chats
    .filter(
      (chat) =>
        waiting.has(chat.id) &&
        !busy.has(chat.id) &&
        chat.agentStatus !== "Paused" &&
        !quickChatAgentRunning(chat)
    )
    .map((chat) => chat.id)
}
