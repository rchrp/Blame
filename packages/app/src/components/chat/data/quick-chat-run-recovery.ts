import type { AgentEvent } from "@blame/agent-runtime"

import {
  completedClineLog,
  finalAssistantResponse,
} from "../../backlog/data/agent-run-recovery.ts"
import { agentPersistenceEvent } from "../../backlog/data/agent-stream-coordinator.ts"
import type {
  QuickChat,
  QuickChatAgentRun,
  QuickChatAgentRunFinalization,
} from "./quick-chat-data.ts"

export const interruptedQuickChatMessage =
  "The agent stopped before its reply reached Blame. Send a message to continue."

type AgentTurnRecoverySources = {
  // Whether the desktop app still runs this session; absent on older builds.
  live?(sessionId: string): Promise<boolean>
  log(sessionId: string): Promise<string>
  messages(sessionId: string): Promise<unknown>
}

export type AgentTurnRecovery =
  { event: AgentEvent; kind: "completed" } | { kind: "interrupted" }

// A turn of a conversation whose turns resume one runtime session.
type ConversationTurn = { createdAt: string; id: string }

// What became of a turn whose events stopped reaching the app (it was not
// followed, or the stream outlived its buffer). Every turn of a chat or plan
// shares one session and one log, so only this turn's lines and reply count.
// A session the desktop still runs is left to its stream, however quiet.
export async function agentTurnRecovery(
  conversation: { agentRuns?: readonly ConversationTurn[] | null },
  run: ConversationTurn,
  sessionId: string,
  sources: AgentTurnRecoverySources
): Promise<AgentTurnRecovery | undefined> {
  const live = await sources.live?.(sessionId).catch(() => true)
  if (live) return undefined
  const endedBefore = nextTurn(conversation, run)?.createdAt
  const log = await sources.log(sessionId).catch(() => "")
  if (completedClineLog(log, run.createdAt, endedBefore)) {
    const messages = await sources.messages(sessionId).catch(() => undefined)
    const text = finalAssistantResponse(messages, run.createdAt, endedBefore)
    return {
      event: { payload: text ? { text } : {}, type: "done" },
      kind: "completed",
    }
  }
  return live === false ? { kind: "interrupted" } : undefined
}

export function interruptedQuickChatRunFinalization(
  chat: Pick<QuickChat, "clineSessionId">,
  run: QuickChatAgentRun,
  completedAt = new Date().toISOString()
): QuickChatAgentRunFinalization {
  return {
    activities: [],
    agentLastError: interruptedQuickChatMessage,
    agentLastEvent: interruptedQuickChatMessage,
    agentStatus: null,
    completedAt,
    finalResponse: run.finalResponse || interruptedQuickChatMessage,
    persistenceEvent: agentPersistenceEvent(
      { createdAt: completedAt, payload: {}, type: "error" },
      {
        executionId: run.executionId ?? run.id,
        lastSequenceNumber: run.lastSequenceNumber,
        runId: run.id,
        sessionId: run.clineSessionId ?? chat.clineSessionId ?? run.id,
      }
    ),
    status: "failed",
  }
}

function nextTurn(
  conversation: { agentRuns?: readonly ConversationTurn[] | null },
  run: ConversationTurn
) {
  const startedAt = Date.parse(run.createdAt)
  return conversation.agentRuns?.find(
    (candidate) =>
      candidate.id !== run.id && Date.parse(candidate.createdAt) > startedAt
  )
}
