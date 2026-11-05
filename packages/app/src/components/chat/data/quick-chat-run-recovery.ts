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
  "Agent interrupted: Blame lost its session (the app restarted or its worker stopped). Send a message to continue."

type QuickChatRecoverySources = {
  // Whether the desktop app still runs this session; absent on older builds.
  live?(sessionId: string): Promise<boolean>
  log(sessionId: string): Promise<string>
  messages(sessionId: string): Promise<unknown>
}

export type QuickChatRunRecovery =
  { event: AgentEvent; kind: "completed" } | { kind: "interrupted" }

// What became of a chat turn whose events stopped reaching the page (it was
// closed, or the stream outlived its buffer). Every turn of a chat shares one
// session and one log, so only this turn's lines and reply count. A session
// the desktop still runs is left to its stream, however quiet it is.
export async function quickChatRunRecovery(
  chat: Pick<QuickChat, "agentRuns">,
  run: QuickChatAgentRun,
  sessionId: string,
  sources: QuickChatRecoverySources
): Promise<QuickChatRunRecovery | undefined> {
  const live = await sources.live?.(sessionId).catch(() => true)
  if (live) return undefined
  const endedBefore = nextQuickChatAgentRun(chat, run)?.createdAt
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

function nextQuickChatAgentRun(
  chat: Pick<QuickChat, "agentRuns">,
  run: QuickChatAgentRun
) {
  const startedAt = Date.parse(run.createdAt)
  return chat.agentRuns?.find(
    (candidate) =>
      candidate.id !== run.id && Date.parse(candidate.createdAt) > startedAt
  )
}
