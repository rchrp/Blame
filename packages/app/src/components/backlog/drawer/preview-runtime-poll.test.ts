import assert from "node:assert/strict"
import test from "node:test"
import type { ProjectPreviewRuntimeState } from "@blame/agent-runtime"

import {
  previewRuntimeChangingPollMs,
  previewRuntimeHiddenPollMs,
  previewRuntimePollDelay,
  previewRuntimeSettledPollMs,
  samePreviewRuntimeState,
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

const visible = { hidden: false, now: 1_000, quickUntil: 0 }

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

test("reads often for a while after an action, rarely in a hidden window", () => {
  const settled = runtime({ web: "running" })
  assert.equal(
    previewRuntimePollDelay({
      ...visible,
      quickUntil: 2_000,
      runtime: settled,
    }),
    previewRuntimeChangingPollMs
  )
  assert.equal(
    previewRuntimePollDelay({
      ...visible,
      hidden: true,
      runtime: runtime({ web: "starting" }),
    }),
    previewRuntimeHiddenPollMs
  )
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
