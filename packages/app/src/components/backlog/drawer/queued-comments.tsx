import { AnimatePresence, motion } from "motion/react"

import { QueuedConversationMessage } from "@/components/chat/agent-conversation"
import {
  removeQueuedComment,
  requestQueuedDelivery,
  updateQueuedComment,
  useQueuedComments,
} from "@/pages/backlog/comment-queue"

// Messages waiting for the agent to finish its turn, shown at the end of the
// conversation. Each one can be sent right away on its own.
export function QueuedComments({
  author,
  onFileLinkClick,
  storyId,
}: {
  author: string
  onFileLinkClick?: (path: string) => void
  storyId?: string
}) {
  const queued = useQueuedComments(storyId)
  if (!storyId || !queued.length) return null

  // Bottom room so the last message's buttons clear the composer; only
  // while something is queued, so the usual layout stays the same.
  return (
    <div className="grid gap-10 pb-8">
      <AnimatePresence initial={false}>
        {queued.map((comment) => (
          <motion.div
            key={comment.id}
            layout
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <QueuedConversationMessage
              comment={{ ...comment, author }}
              onFileLinkClick={onFileLinkClick}
              onEdit={(body) => updateQueuedComment(comment.id, body)}
              onRemove={() => removeQueuedComment(comment.id)}
              onSendNow={() => requestQueuedDelivery(storyId, comment.id)}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
