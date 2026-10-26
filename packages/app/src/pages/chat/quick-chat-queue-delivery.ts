import {
  mergeQueuedComments,
  queuedComments,
  removeQueuedComment,
} from "../backlog/comment-queue.ts"

type QueuedMessage = ReturnType<typeof mergeQueuedComments>

export class QuickChatQueueDelivery {
  private delivering = new Set<string>()
  private failed = new Set<string>()

  async deliver({
    chatId,
    commentId,
    automatic = false,
    stop,
    send,
  }: {
    chatId: string
    commentId?: string
    automatic?: boolean
    stop?: (chatId: string) => Promise<unknown>
    send(chatId: string, message: QueuedMessage): Promise<void>
  }) {
    if (this.delivering.has(chatId) || (automatic && this.failed.has(chatId)))
      return
    this.delivering.add(chatId)
    try {
      if (stop) await stop(chatId)
      const comments = queuedComments(`chat:${chatId}`).filter(
        (comment) => !commentId || comment.id === commentId
      )
      if (!comments.length) return
      await send(chatId, mergeQueuedComments(comments))
      for (const comment of comments) removeQueuedComment(comment.id)
      this.failed.delete(chatId)
    } catch (error) {
      // Keep failed messages editable and available for an explicit retry.
      this.failed.add(chatId)
      throw error
    } finally {
      this.delivering.delete(chatId)
    }
  }
}
