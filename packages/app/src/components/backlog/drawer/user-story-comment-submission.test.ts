import assert from "node:assert/strict"
import test from "node:test"
import type { UserStory, UserStoryComment } from "../data/backlog-data.ts"
import {
  commentsWithoutAgentRun,
  createUserStoryCommentSubmission,
} from "./user-story-comment-submission.ts"

const story: UserStory = {
  id: "story",
  projectId: "project",
  storyNumber: 8,
  title: "Carousel",
  summary: "",
  status: "in-review",
  priority: "Medium",
  owner: "Product",
  createdAt: "2026-09-12T16:00:00Z",
}
const comment: UserStoryComment = {
  id: "comment",
  userStoryId: story.id,
  body: "Improve the carousel",
  author: "Product",
  createdAt: "2026-09-12T16:25:44Z",
}
const started: UserStory = { ...story, status: "in-progress" }

test("a second click is ignored while saving or starting the agent", async () => {
  const submission = createUserStoryCommentSubmission()
  let finishSave!: (value: UserStoryComment) => void
  let finishStart!: (value: UserStory) => void
  let creates = 0
  let starts = 0
  const input = {
    story,
    input: comment,
    createComment: () => {
      creates++
      return new Promise<UserStoryComment>((resolve) => {
        finishSave = resolve
      })
    },
    requestChanges: () => {
      starts++
      return new Promise<UserStory>((resolve) => {
        finishStart = resolve
      })
    },
  }
  const first = submission.submit(input)
  assert.equal(await submission.submit(input), false)
  finishSave(comment)
  await Promise.resolve()
  assert.equal(await submission.submit(input), false)
  finishStart(started)
  assert.equal(await first, true)
  assert.equal(submission.pending, false)
  assert.equal(creates, 1)
  assert.equal(starts, 1)
})

for (const throws of [false, true]) {
  test(`retry reuses the saved comment after ${throws ? "a thrown error" : "a rejected start"}`, async () => {
    const submission = createUserStoryCommentSubmission()
    let creates = 0
    const sentIds: string[] = []
    let fail = true
    const input = {
      story,
      input: comment,
      createComment: async () => {
        creates++
        return comment
      },
      requestChanges: async (saved: UserStoryComment) => {
        sentIds.push(saved.id)
        if (fail && throws) throw new Error("session.create timed out")
        return fail ? story : started
      },
    }
    if (throws) await assert.rejects(submission.submit(input), /timed out/)
    else assert.equal(await submission.submit(input), false)
    assert.equal(submission.pending, false)
    fail = false
    assert.equal(await submission.submit(input), true)
    assert.equal(creates, 1)
    assert.deepEqual(sentIds, [comment.id, comment.id])
  })
}

test("reopening the drawer reuses a matching comment without an agent run", async () => {
  const submission = createUserStoryCommentSubmission()
  const result = await submission.submit({
    story: { ...story, comments: [comment] },
    input: comment,
    createComment: async () => assert.fail("must reuse the existing comment"),
    requestChanges: async (saved) => {
      assert.equal(saved.id, comment.id)
      return started
    },
  })
  assert.equal(result, true)
})

test("a comment already associated with a run is not reused", async () => {
  let creates = 0
  await createUserStoryCommentSubmission().submit({
    story: {
      ...story,
      comments: [comment],
      agentRuns: [
        {
          id: "run",
          userStoryId: story.id,
          commentId: comment.id,
          kind: "change-request",
          status: "completed",
          createdAt: comment.createdAt,
        },
      ],
    },
    input: comment,
    createComment: async () => {
      creates++
      return { ...comment, id: "new" }
    },
    requestChanges: async (saved) => {
      assert.equal(saved.id, "new")
      return started
    },
  })
  assert.equal(creates, 1)
})

test("editing the feedback or its attachments creates a new comment", async () => {
  const submission = createUserStoryCommentSubmission()
  let creates = 0
  const options = {
    story,
    createComment: async (input: Pick<UserStoryComment, "body">) => ({
      ...comment,
      ...input,
      id: `comment-${++creates}`,
    }),
    requestChanges: async () => story,
  }
  await submission.submit({ ...options, input: comment })
  await submission.submit({
    ...options,
    input: { ...comment, body: "New feedback" },
  })
  await submission.submit({
    ...options,
    input: {
      ...comment,
      fileAttachments: [
        { id: "file", name: "a.txt", size: 1, type: "text/plain" },
      ],
    },
  })
  assert.equal(creates, 3)
})

test("feedback while the agent is running waits for its handoff before clearing the composer", async () => {
  const submission = createUserStoryCommentSubmission()
  let resolveHandoff!: (value: UserStory | undefined) => void
  const ids: string[] = []
  const result = submission.submit({
    story: started,
    input: comment,
    createComment: async () => comment,
    requestChanges: (saved) => {
      ids.push(saved.id)
      return new Promise((resolve) => {
        resolveHandoff = resolve
      })
    },
  })
  await Promise.resolve()
  assert.equal(submission.pending, true)
  assert.deepEqual(ids, [comment.id])
  resolveHandoff(started)
  assert.equal(await result, true)
  assert.equal(submission.pending, false)
})

test("failed feedback handoff during a running story retains the saved comment for retry", async () => {
  const submission = createUserStoryCommentSubmission()
  let creates = 0
  let reject = true
  const options = {
    story: started,
    input: comment,
    createComment: async () => {
      creates++
      return comment
    },
    requestChanges: async () => (reject ? undefined : started),
  }
  assert.equal(await submission.submit(options), false)
  reject = false
  assert.equal(await submission.submit(options), true)
  assert.equal(creates, 1)
})

test("the saved comment is reported before the agent handoff finishes", async () => {
  const submission = createUserStoryCommentSubmission()
  const events: string[] = []
  await submission.submit({
    story: started,
    input: comment,
    createComment: async () => comment,
    onCommentSaved: (saved) => events.push(`saved:${saved.id}`),
    requestChanges: async () => {
      events.push("handoff")
      return started
    },
  })
  assert.deepEqual(events, [`saved:${comment.id}`, "handoff"])
})

test("a saved comment without a run stays visible and can be reused after reopening", async () => {
  const linkedComment = { ...comment, id: "delivered" }
  const current: UserStory = {
    ...started,
    comments: [linkedComment, comment],
    agentRuns: [
      {
        id: "run",
        userStoryId: story.id,
        commentId: linkedComment.id,
        kind: "change-request",
        status: "running",
        createdAt: comment.createdAt,
      },
    ],
  }
  assert.deepEqual(commentsWithoutAgentRun(current), [comment])
  assert.deepEqual(commentsWithoutAgentRun({ comments: [comment] }), [comment])
  assert.equal(
    await createUserStoryCommentSubmission().submit({
      story: current,
      input: comment,
      createComment: async () =>
        assert.fail("saved comment must not be duplicated"),
      requestChanges: async (saved) => {
        assert.equal(saved.id, comment.id)
        return current
      },
    }),
    true
  )
})
