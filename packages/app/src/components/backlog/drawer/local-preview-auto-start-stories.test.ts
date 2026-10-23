import assert from "node:assert/strict"
import test from "node:test"

import { localPreviewAutoStartStories } from "./local-preview-auto-start-stories.ts"

const story = (
  id: string,
  updatedAt: string,
  overrides: Record<string, unknown> = {}
) => ({
  id,
  status: "in-review",
  workspaceMode: "local-container",
  worktree: `/home/blame/worktrees/${id}`,
  updatedAt,
  ...overrides,
})

test("starts the previews of the most recent local stories in review", () => {
  const stories = [
    story("old", "2026-10-20T10:00:00Z"),
    story("new", "2026-10-24T10:00:00Z"),
    story("middle", "2026-10-22T10:00:00Z"),
    story("working", "2026-10-24T11:00:00Z", { status: "in-progress" }),
    story("cloud", "2026-10-24T12:00:00Z", { workspaceMode: "cloud-mirror" }),
    story("no-worktree", "2026-10-24T13:00:00Z", { worktree: null }),
  ]
  assert.deepEqual(
    localPreviewAutoStartStories(stories).map(({ id }) => id),
    ["new", "middle"]
  )
})
