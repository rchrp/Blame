import assert from "node:assert/strict"
import test from "node:test"

import {
  closeStoryRunStreams,
  forgetRunStream,
  registerRunStream,
  runStreamOpen,
} from "./agent-run-streams.ts"

test("keeps a single stream per run", () => {
  assert.equal(registerRunStream("r1", "s1", () => undefined), true)
  assert.equal(registerRunStream("r1", "s1", () => undefined), false)
  assert.equal(runStreamOpen("r1"), true)
  forgetRunStream("r1")
  assert.equal(runStreamOpen("r1"), false)
})

test("only the owner can forget a stream", () => {
  const owner = () => undefined
  registerRunStream("r2", "s1", owner)
  forgetRunStream("r2", () => undefined)
  assert.equal(runStreamOpen("r2"), true)
  forgetRunStream("r2", owner)
  assert.equal(runStreamOpen("r2"), false)
})

test("closes a story's earlier runs but not the new one", () => {
  const closed: string[] = []
  registerRunStream("old", "s9", () => closed.push("old"))
  registerRunStream("new", "s9", () => closed.push("new"))
  registerRunStream("other", "s8", () => closed.push("other"))
  closeStoryRunStreams("s9", "new")
  assert.deepEqual(closed, ["old"])
  assert.equal(runStreamOpen("new"), true)
  assert.equal(runStreamOpen("other"), true)
})
