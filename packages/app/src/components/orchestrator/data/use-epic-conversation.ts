import type { TranscriptConversation } from "@/components/chat/engine/transcript-conversation"
import type { EngineConversationMessage } from "@/components/chat/engine/use-engine-conversation"
import type { Epic } from "@/components/orchestrator/data/epic-data"

// The epic's conversation with its orchestrator: the engine session named in
// `epic.engineSessionId` (docs/orchestrator.md, "The conversation"). The
// engine host has no `orchestrator` purpose in this build yet, so the
// conversation says so instead of answering. Wiring it means: follow the
// session with useEngineSession, create it on the first message with the
// purpose's settings (workspace, projectId, epicId, context cap,
// personalization), write its id to the epic, and send.

export type EpicConversation = {
  conversation: Pick<TranscriptConversation, "comments" | "runs">
  running: boolean
  // The engine session, once the first message created it.
  session?: string
  // Starts sending; false when the conversation cannot take a message.
  send: (message: EngineConversationMessage) => boolean
  stop: () => void
  // Why nothing can be sent now.
  unavailableReason?: string
}

const noConversation: EpicConversation["conversation"] = {
  comments: [],
  runs: [],
}

export function useEpicConversation(epic: Epic): EpicConversation {
  return {
    conversation: noConversation,
    running: false,
    session: epic.engineSessionId ?? undefined,
    send: () => false,
    stop: () => undefined,
    unavailableReason:
      "The orchestrator needs a newer engine than this build has.",
  }
}
