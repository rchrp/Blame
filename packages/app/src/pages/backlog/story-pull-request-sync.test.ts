import assert from "node:assert/strict"
import test from "node:test"

import type {
  UserStory,
  UserStoryUpdate,
} from "../../components/backlog/data/backlog-data.ts"
import {
  applyPullRequestState,
  isSyncedStory,
  type SyncedStory,
} from "./story-pull-request-sync.ts"

const pullRequestUrl = "https://github.com/acme/shop/pull/7"

function reviewStory(overrides: Partial<UserStory> = {}): SyncedStory {
  return {
    id: "story-1",
    projectId: "project-1",
    storyNumber: 1,
    title: "Ship the checkout",
    summary: "Let people pay.",
    status: "in-review",
    priority: "Medium",
    owner: "Product",
    branch: "story/checkout",
    clineSessionId: "session-1",
    createdAt: "2026-11-09T09:00:00Z",
    worktree: "/worktrees/story-1",
    workspaceMode: "local-container",
    ...overrides,
    pullRequestUrl: overrides.pullRequestUrl ?? pullRequestUrl,
  }
}

function recordedEffects() {
  const updates: Array<{
    input: UserStoryUpdate
    options: { cleanup: false }
    story: UserStory
  }> = []
  const cleaned: UserStory[] = []
  return {
    cleaned,
    updates,
    effects: {
      async cleanupMergedStory(story: UserStory) {
        cleaned.push(story)
      },
      async updateStory(
        story: UserStory,
        input: UserStoryUpdate,
        options: { cleanup: false }
      ) {
        updates.push({ input, options, story })
        return { ...story, ...input } as UserStory
      },
    },
  }
}

test("watches the stories in review that have a pull request", () => {
  const withoutPullRequest = (pullRequestUrl: string | null): UserStory => ({
    ...reviewStory(),
    pullRequestUrl,
  })
  assert.equal(isSyncedStory(reviewStory()), true)
  assert.equal(isSyncedStory(withoutPullRequest(null)), false)
  assert.equal(isSyncedStory(withoutPullRequest("")), false)
  assert.equal(isSyncedStory(reviewStory({ status: "done" })), false)
  assert.equal(isSyncedStory(reviewStory({ status: "in-progress" })), false)
})

test("a pull request merged on GitHub makes the story done and cleans it up", async () => {
  const story = reviewStory()
  const { cleaned, effects, updates } = recordedEffects()

  const outcome = await applyPullRequestState(
    story,
    { status: "merged", mergedAt: "2026-11-09T10:15:00Z" },
    effects
  )

  assert.equal(outcome, "merged")
  assert.equal(updates.length, 1)
  const [update] = updates
  assert.equal(update?.story, story)
  // The cleanup is the merge's own: no second one when the status changes.
  assert.deepEqual(update?.options, { cleanup: false })
  assert.deepEqual(update?.input, {
    agentLastError: null,
    agentLastEvent: "Pull request merged on GitHub.",
    agentStatus: null,
    branch: null,
    clineSessionId: null,
    mergedAt: "2026-11-09T10:15:00Z",
    previewUrl: null,
    status: "done",
    worktree: null,
    workspaceMode: null,
  })
  // The story is cleaned up as it was in review, with its worktree and agent.
  assert.deepEqual(cleaned, [story])
  assert.equal(cleaned[0]?.worktree, "/worktrees/story-1")
})

test("a merged pull request is not merged again locally", async () => {
  const { effects, updates } = recordedEffects()

  await applyPullRequestState(
    reviewStory(),
    { status: "merged", mergedAt: "2026-11-09T10:15:00Z" },
    effects
  )

  const [update] = updates
  assert.equal(update?.input.mergeCommit, undefined)
  assert.equal(update?.input.baseCommit, undefined)
  assert.equal(update?.input.pullRequestUrl, undefined)
})

test("a pull request closed without merge gives the story its actions back", async () => {
  const { cleaned, effects, updates } = recordedEffects()

  const outcome = await applyPullRequestState(
    reviewStory(),
    { status: "closed" },
    effects
  )

  assert.equal(outcome, "closed")
  assert.deepEqual(
    updates.map(({ input }) => input),
    [
      {
        agentLastError: null,
        agentLastEvent: "Pull request closed without merging.",
        pullRequestUrl: null,
      },
    ]
  )
  // The story stays in review with its worktree: only the link goes.
  assert.equal(updates[0]?.input.status, undefined)
  assert.equal(cleaned.length, 0)
})

test("an open or unknown pull request leaves the story as it is", async () => {
  for (const state of [
    { status: "open" },
    { status: "unavailable" },
  ] as const) {
    const { cleaned, effects, updates } = recordedEffects()
    assert.equal(
      await applyPullRequestState(reviewStory(), state, effects),
      undefined
    )
    assert.equal(updates.length, 0)
    assert.equal(cleaned.length, 0)
  }
})

test("a story that cannot be updated is not cleaned up", async () => {
  const cleaned: UserStory[] = []
  await assert.rejects(
    applyPullRequestState(
      reviewStory(),
      { status: "merged", mergedAt: "2026-11-09T10:15:00Z" },
      {
        async cleanupMergedStory(story) {
          cleaned.push(story)
        },
        async updateStory() {
          throw new Error("offline")
        },
      }
    ),
    /offline/
  )
  assert.equal(cleaned.length, 0)
})
