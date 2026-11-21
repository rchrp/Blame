import assert from "node:assert/strict"
import test from "node:test"

import type { UserStory } from "../../components/backlog/data/backlog-data.ts"
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
    engineSessionId: "session-1",
    createdAt: "2026-11-09T09:00:00Z",
    worktree: "/worktrees/story-1",
    workspaceMode: "local-container",
    ...overrides,
    pullRequestUrl: overrides.pullRequestUrl ?? pullRequestUrl,
  }
}

function recordedEffects() {
  const completed: Array<{ mergedAt: string; story: UserStory }> = []
  const forgotten: UserStory[] = []
  return {
    completed,
    forgotten,
    effects: {
      async completeStory(story: UserStory, mergedAt: string) {
        completed.push({ mergedAt, story })
      },
      async forgetPullRequest(story: UserStory) {
        forgotten.push(story)
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

test("a pull request merged on GitHub makes the story done, nothing merged again here", async () => {
  const story = reviewStory()
  const { completed, effects, forgotten } = recordedEffects()

  const outcome = await applyPullRequestState(
    story,
    { status: "merged", mergedAt: "2026-11-09T10:15:00Z" },
    effects
  )

  assert.equal(outcome, "merged")
  // The story service makes it done and cleans it up as it was in review.
  assert.deepEqual(completed, [{ mergedAt: "2026-11-09T10:15:00Z", story }])
  assert.equal(forgotten.length, 0)
})

test("a pull request closed without merge gives the story its actions back", async () => {
  const story = reviewStory()
  const { completed, effects, forgotten } = recordedEffects()

  const outcome = await applyPullRequestState(
    story,
    { status: "closed" },
    effects
  )

  assert.equal(outcome, "closed")
  // The story stays in review with its worktree: only the link goes.
  assert.deepEqual(forgotten, [story])
  assert.equal(completed.length, 0)
})

test("an open or unknown pull request leaves the story as it is", async () => {
  for (const state of [
    { status: "open" },
    { status: "unavailable" },
  ] as const) {
    const { completed, effects, forgotten } = recordedEffects()
    assert.equal(
      await applyPullRequestState(reviewStory(), state, effects),
      undefined
    )
    assert.equal(completed.length, 0)
    assert.equal(forgotten.length, 0)
  }
})
