import { toast } from "sonner"

import { QueuedConversationMessage } from "@/components/chat/agent-conversation"
import type { QueuedMessage } from "@/components/chat/engine/transcript-conversation"

/** What can be done with a queued message; the engine keeps the queue. */
export type QueuedMessageControls = {
  /** Takes it out of the queue: it never reaches the agent. */
  remove(turn: string): Promise<void>
  /** Sends it into the running turn instead of after it. */
  sendNow(turn: string): Promise<void>
  /** Replaces its text: taken out, then queued again with the new text. */
  edit(turn: string, text: string): Promise<void>
}

/**
 * The messages waiting for the running turn to end, after the conversation,
 * dashed, with Send now, remove and (text only) edit.
 */
export function QueuedMessages({
  controls,
  onFileLinkClick,
  queued,
}: {
  controls: QueuedMessageControls
  onFileLinkClick?: (path: string) => void
  queued: QueuedMessage[]
}) {
  return queued.map((message) => (
    <QueuedConversationMessage
      key={message.turn}
      comment={message.comment}
      onFileLinkClick={onFileLinkClick}
      onEdit={
        message.editable
          ? (text) => void act(controls.edit(message.turn, text))
          : undefined
      }
      onRemove={() => void act(controls.remove(message.turn))}
      onSendNow={() => void act(controls.sendNow(message.turn))}
    />
  ))
}

async function act(action: Promise<void>) {
  try {
    await action
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The turn ended meanwhile: the message is already the agent's.
    if (message.includes("not waiting in the queue")) {
      toast.info("The agent already has this message.", {
        position: "bottom-right",
      })
      return
    }
    toast.error(message, { position: "bottom-right" })
  }
}
