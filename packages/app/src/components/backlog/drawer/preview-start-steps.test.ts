import assert from "node:assert/strict"
import test from "node:test"

import {
  formatStepDuration,
  nextPreviewStartHistory,
} from "./preview-start-steps.ts"

test("records each new step of a start attempt once", () => {
  let history = nextPreviewStartHistory({ steps: [] }, "a", "Installing", 0)
  history = nextPreviewStartHistory(history, "a", "Installing", 500)
  history = nextPreviewStartHistory(history, "a", "Starting the app", 4000)
  assert.deepEqual(history, {
    attempt: "a",
    steps: [
      { label: "Installing", startedAt: 0 },
      { label: "Starting the app", startedAt: 4000 },
    ],
  })
  const same = nextPreviewStartHistory(history, "a", "Starting the app", 5000)
  assert.equal(same, history)
})

test("a new start attempt starts a new list", () => {
  const first = nextPreviewStartHistory({ steps: [] }, "a", "Installing", 0)
  assert.deepEqual(nextPreviewStartHistory(first, "b", "Installing", 9000), {
    attempt: "b",
    steps: [{ label: "Installing", startedAt: 9000 }],
  })
})

test("formats step durations for people", () => {
  assert.equal(formatStepDuration(4200), "4s")
  assert.equal(formatStepDuration(72_000), "1 min 12s")
  assert.equal(formatStepDuration(120_000), "2 min")
})
