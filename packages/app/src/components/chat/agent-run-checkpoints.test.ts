import assert from "node:assert/strict"
import test from "node:test"

import {
  checkpointRunTargets,
  nextCheckpointRunCount,
} from "./agent-run-checkpoints.ts"

test("ignores session-less runs when assigning checkpoint boundaries", () => {
  const first = { clineSessionId: "session-1", id: "first" }
  const failed = { clineSessionId: null, id: "failed" }
  const second = { clineSessionId: "session-2", id: "second" }

  const targets = checkpointRunTargets([first, failed, second])

  assert.deepEqual(targets, [
    { checkpointRunCount: 1 },
    undefined,
    { checkpointRunCount: 2 },
  ])
})

test("uses persisted checkpoint positions when history contains gaps", () => {
  const first = {
    checkpointRunCount: 3,
    clineSessionId: "session-1",
    id: "first",
  }
  const second = {
    checkpointRunCount: 7,
    clineSessionId: "session-2",
    id: "second",
  }

  assert.deepEqual(checkpointRunTargets([first, second]), [
    { checkpointRunCount: 3 },
    { checkpointRunCount: 7 },
  ])
  assert.equal(nextCheckpointRunCount([first, second]), 8)
})

test("an engine turn that can be undone carries its own checkpoint", () => {
  assert.deepEqual(
    checkpointRunTargets([
      { checkpointRunCount: 1, id: "a" },
      { checkpointRunCount: null, id: "b" },
    ]),
    [{ checkpointRunCount: 1 }, undefined]
  )
})
