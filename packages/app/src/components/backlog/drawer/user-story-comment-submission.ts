import type { UserStory, UserStoryComment } from "../data/backlog-data.ts"

type CommentInput = Pick<
  UserStoryComment,
  "body" | "codeSelectionAttachments" | "fileAttachments"
>

type Submission = {
  story: UserStory
  input: CommentInput
  createComment: (input: CommentInput) => Promise<UserStoryComment>
  requestChanges: (comment: UserStoryComment) => Promise<UserStory | undefined>
  // Called once the comment exists, before the (slow) agent handoff starts.
  onCommentSaved?: (comment: UserStoryComment) => void
}

export function createUserStoryCommentSubmission() {
  let pending = false
  let saved:
    | { storyId: string; key: string; comment: UserStoryComment }
    | undefined

  return {
    get pending() {
      return pending
    },
    async submit({
      story,
      input,
      createComment,
      requestChanges,
      onCommentSaved,
    }: Submission) {
      if (pending) return false
      pending = true
      try {
        const key = commentKey(input)
        const previous =
          saved?.storyId === story.id && saved.key === key
            ? saved.comment
            : undefined
        const comment =
          previous ??
          recoverableComment(story, key) ??
          (await createComment(input))
        saved = { storyId: story.id, key, comment }
        onCommentSaved?.(comment)
        if (story.status === "in-review" || story.status === "in-progress") {
          const nextStory = await requestChanges(comment)
          if (nextStory?.status !== "in-progress") return false
        }
        saved = undefined
        return true
      } finally {
        pending = false
      }
    },
  }
}

function recoverableComment(story: UserStory, key: string) {
  if (story.status !== "in-review" && story.status !== "in-progress")
    return undefined
  const runs = story.agentRuns ?? []
  const latestRunCreatedAt = Math.max(
    0,
    ...runs.map((run) => Date.parse(run.createdAt))
  )
  return [...commentsWithoutAgentRun(story)]
    .reverse()
    .find(
      (comment) =>
        Date.parse(comment.createdAt) >= latestRunCreatedAt &&
        commentKey(comment) === key
    )
}

export function commentsWithoutAgentRun(
  story: Pick<UserStory, "comments" | "agentRuns">
) {
  const linked = new Set((story.agentRuns ?? []).map((run) => run.commentId))
  return (story.comments ?? []).filter((comment) => !linked.has(comment.id))
}

function commentKey(input: CommentInput) {
  return JSON.stringify({
    body: input.body,
    code: (input.codeSelectionAttachments ?? []).map((attachment) => ({
      id: attachment.id,
      content: attachment.content,
      path: attachment.path,
      startLine: attachment.startLine,
      endLine: attachment.endLine,
    })),
    files: (input.fileAttachments ?? []).map((attachment) => attachment.id),
  })
}
