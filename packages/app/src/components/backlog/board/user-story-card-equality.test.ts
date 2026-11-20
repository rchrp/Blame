import assert from "node:assert/strict"
import test from "node:test"

import type { UserStory } from "../data/backlog-data.ts"
import { equalUserStoryCardStory } from "./user-story-card-equality.ts"

function story(overrides: Partial<UserStory> = {}): UserStory {
  return {
    createdAt: "2026-07-25T00:00:00.000Z",
    id: "story",
    owner: "user",
    priority: "medium",
    projectId: "project",
    status: "in-progress",
    storyNumber: 1,
    summary: "Summary",
    title: "Title",
    ...overrides,
  }
}

test("detects fields that change card content or actions", () => {
  const previous = story()

  assert.equal(
    equalUserStoryCardStory(previous, story({ title: "Next" })),
    false
  )
  assert.equal(
    equalUserStoryCardStory(previous, story({ agentStatus: "Paused" })),
    false
  )
  assert.equal(
    equalUserStoryCardStory(
      previous,
      story({ fileAttachmentUploadStatus: "uploading" })
    ),
    false
  )
})
