import assert from "node:assert/strict"
import test from "node:test"
import type { ProjectPreviewRuntimeState } from "@blame/agent-runtime"

import {
  previewRuntimeChangingPollMs,
  previewRuntimePollDelay,
  previewRuntimeSettledPollMs,
  samePreviewRuntimeState,
  samePreviewWorktree,
} from "./preview-runtime-poll.ts"

function runtime(
  statuses: ProjectPreviewRuntimeState["statuses"],
  lifecycle?: ProjectPreviewRuntimeState["lifecycle"]
): ProjectPreviewRuntimeState {
  return {
    configurations: [
      {
        category: "web",
        command: "pnpm dev",
        cwd: ".",
        default: true,
        id: "web",
        name: "Web",
        scopes: [],
        services: ["web"],
      },
    ],
    desiredStatus: "running",
    lifecycle,
    statuses,
  }
}

const visible = { hidden: false }

test("reads a settled preview's state rarely", () => {
  assert.equal(
    previewRuntimePollDelay({
      ...visible,
      runtime: runtime({ web: "running" }),
    }),
    previewRuntimeSettledPollMs
  )
  assert.equal(
    previewRuntimePollDelay({
      ...visible,
      runtime: runtime({ web: "stopped" }),
    }),
    previewRuntimeSettledPollMs
  )
})

test("reads a changing or unknown preview's state often", () => {
  assert.equal(
    previewRuntimePollDelay({ ...visible, runtime: undefined }),
    previewRuntimeChangingPollMs
  )
  assert.equal(
    previewRuntimePollDelay({
      ...visible,
      runtime: runtime({ web: "starting" }),
    }),
    previewRuntimeChangingPollMs
  )
  assert.equal(
    previewRuntimePollDelay({
      ...visible,
      runtime: runtime(
        { web: "stopped" },
        { phase: "starting", since: "2026-11-05T22:00:00Z", status: "pending" }
      ),
    }),
    previewRuntimeChangingPollMs
  )
})

test("reads nothing while the window is hidden", () => {
  assert.equal(
    previewRuntimePollDelay({
      hidden: true,
      runtime: runtime({ web: "starting" }),
    }),
    undefined
  )
})

test("matches the desktop's change to the worktree shown", () => {
  assert.equal(samePreviewWorktree("/w/story-1", "/w/story-1/"), true)
  assert.equal(samePreviewWorktree("C:\\w\\story-1", "C:/w/story-1"), true)
  assert.equal(samePreviewWorktree("/w/story-1", "/w/story-12"), false)
})

test("keeps the current state when a read brings nothing new", () => {
  const current = runtime({ web: "running" })
  assert.equal(
    samePreviewRuntimeState(current, runtime({ web: "running" })),
    true
  )
  assert.equal(
    samePreviewRuntimeState(current, runtime({ web: "stopped" })),
    false
  )
  assert.equal(samePreviewRuntimeState(undefined, current), false)
})
