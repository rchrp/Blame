import assert from "node:assert/strict"
import test from "node:test"

import { deadAgentRuns, deadSessionGraceMs } from "./agent-run-liveness.ts"

const now = Date.parse("2026-10-19T12:00:00Z")
const ago = (ms: number) => new Date(now - ms).toISOString()
const story = (id: string, run: Record<string, unknown>) =>
  ({ id, clineSessionId: `session-${id}`, agentRuns: [{ id: `run-${id}`, status: "running", createdAt: ago(60_000), ...run }] }) as never

test("recovers a quiet run whose session is gone, right away", async () => {
  const dead = await deadAgentRuns([story("a", { updatedAt: ago(20_000) })], async () => false, { now })
  assert.deepEqual(dead.map(({ story }) => (story as { id: string }).id), ["a"])
})

test("never touches a live session, however long it has been quiet", async () => {
  const dead = await deadAgentRuns([story("a", { updatedAt: ago(10 * 60_000) })], async () => true, { now })
  assert.equal(dead.length, 0)
})

test("gives a just-started run time to register", async () => {
  const dead = await deadAgentRuns(
    [story("a", { createdAt: ago(1_000), updatedAt: ago(1_000) })],
    async () => false,
    { now }
  )
  assert.equal(dead.length, 0)
  assert.ok(deadSessionGraceMs > 1_000)
})

test("skips stories in transition, finished runs, and unknown liveness", async () => {
  const dead = await deadAgentRuns(
    [
      story("busy", { updatedAt: ago(30_000) }),
      story("done", { updatedAt: ago(30_000), finalResponse: "ok" }),
      story("error", { updatedAt: ago(30_000) }),
    ],
    async (sessionId) => {
      if (sessionId === "session-error") throw new Error("ipc down")
      return false
    },
    { now, skip: new Set(["busy"]) }
  )
  assert.equal(dead.length, 0)
})
