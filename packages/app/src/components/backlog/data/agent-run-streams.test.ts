import assert from "node:assert/strict"
import test from "node:test"

import {
  closeStoryRunStreams,
  forgetRunStream,
  registerRunStream,
  runStreamOpen,
  settleStoryRunStreams,
} from "./agent-run-streams.ts"

test("keeps a single stream per run", () => {
  assert.equal(
    registerRunStream("r1", "s1", () => undefined),
    true
  )
  assert.equal(
    registerRunStream("r1", "s1", () => undefined),
    false
  )
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
  closeStoryRunStreams("s9")
  closeStoryRunStreams("s8")
})

test("settling a story waits for its pending writes and leaves other stories open", async () => {
  const operations: string[] = []
  let finishFlush!: () => void
  const pending = new Promise<void>((resolve) => {
    finishFlush = resolve
  })
  registerRunStream(
    "settling",
    "s10",
    () => {
      operations.push("close")
    },
    async () => {
      operations.push("flush")
      await pending
    }
  )
  registerRunStream("unrelated", "s11", () =>
    assert.fail("unrelated stream closed")
  )
  const settling = settleStoryRunStreams("s10").then(() => {
    operations.push("settled")
  })
  try {
    assert.deepEqual(operations, ["close", "flush"])
    assert.equal(runStreamOpen("settling"), false)
    assert.equal(runStreamOpen("unrelated"), true)
    finishFlush()
    await settling
    assert.deepEqual(operations, ["close", "flush", "settled"])
  } finally {
    finishFlush()
    forgetRunStream("unrelated")
  }
})

test("settling propagates persistence failures to prevent premature cancellation", async () => {
  registerRunStream(
    "failed",
    "s12",
    () => undefined,
    async () => {
      throw new Error("Persistence unavailable")
    }
  )
  await assert.rejects(settleStoryRunStreams("s12"), /Persistence unavailable/)
  assert.equal(runStreamOpen("failed"), false)
})
