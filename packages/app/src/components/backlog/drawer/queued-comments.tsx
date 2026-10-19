import { AnimatePresence, motion } from "motion/react"

import { QueuedConversationMessage } from "@/components/chat/agent-conversation"
import {
  removeQueuedComment,
  requestQueuedDelivery,
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
  if (!storyId) return null

  return (
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
            onRemove={() => removeQueuedComment(comment.id)}
            onSendNow={() => requestQueuedDelivery(storyId, comment.id)}
          />
        </motion.div>
      ))}
    </AnimatePresence>
  )
}
