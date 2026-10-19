import { ClockIcon, SendIcon, XIcon } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"

import { Button } from "@/components/ui/button"
import {
  removeQueuedComment,
  requestQueuedDelivery,
  useQueuedComments,
} from "@/pages/backlog/comment-queue"

// Comments waiting for the agent to finish its turn. "Send now" interrupts
// it: the agent stops, reads them, and carries on with what it was doing.
export function QueuedComments({ storyId }: { storyId?: string }) {
  const queued = useQueuedComments(storyId)
  if (!storyId) return null

  return (
    <AnimatePresence initial={false}>
      {queued.length ? (
        <motion.div
          key="queued"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="mb-2 grid gap-1.5 rounded-xl bg-muted/50 p-2"
        >
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <ClockIcon className="size-3.5" />
            <span className="min-w-0 flex-1">
              {queued.length === 1
                ? "Queued: sent when the agent finishes"
                : `${queued.length} queued: sent together when the agent finishes`}
            </span>
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1.5 rounded-lg px-2.5 text-xs"
              onClick={() => requestQueuedDelivery(storyId)}
            >
              <SendIcon className="size-3.5" />
              Send now
            </Button>
          </div>
          <ul className="grid gap-1">
            <AnimatePresence initial={false}>
              {queued.map((comment) => (
                <motion.li
                  key={comment.id}
                  layout
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="group/queued flex items-start gap-2 overflow-hidden rounded-lg bg-background px-3 py-2 text-sm shadow-xs"
                >
                  <p className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap">
                    {comment.body}
                    {comment.fileAttachments.length + comment.codeSelectionAttachments.length ? (
                      <span className="ml-1 text-xs text-muted-foreground">
                        +{comment.fileAttachments.length + comment.codeSelectionAttachments.length} attached
                      </span>
                    ) : null}
                  </p>
                  <button
                    type="button"
                    aria-label="Remove queued comment"
                    title="Remove"
                    className="mt-0.5 rounded text-muted-foreground opacity-60 transition-opacity hover:text-foreground hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => removeQueuedComment(comment.id)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
