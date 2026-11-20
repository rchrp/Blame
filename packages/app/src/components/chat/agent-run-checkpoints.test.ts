import assert from "node:assert/strict"
import test from "node:test"

import { checkpointRunTargets } from "./agent-run-checkpoints.ts"

test("a turn that can be undone carries its own checkpoint", () => {
  assert.deepEqual(
    checkpointRunTargets([
      { checkpointRunCount: 1 },
      { checkpointRunCount: null },
      { checkpointRunCount: 2 },
    ]),
    [{ checkpointRunCount: 1 }, undefined, { checkpointRunCount: 2 }]
  )
})
