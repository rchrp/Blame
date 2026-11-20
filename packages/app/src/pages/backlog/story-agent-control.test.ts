import assert from "node:assert/strict"
import test from "node:test"

import { pauseInterruptRefusal } from "./story-agent-control.ts"

const story = {
  agentStatus: "Running" as const,
  engineSessionId: "session",
  workspaceMode: "direct" as const,
}

test("a pause interrupts the running turn of the story's session", async () => {
  const calls: unknown[] = []
  const engine = {
    call: async (method: string, input: unknown) => {
      calls.push([method, input])
      return null as never
    },
  }
  assert.equal(await pauseInterruptRefusal(story, engine, "darwin"), undefined)
  assert.deepEqual(calls, [
    ["interrupt", { session: "session", location: "host" }],
  ])
})

test("nothing to stop on a paused story, and a refusal is returned", async () => {
  const engine = {
    call: async () => {
      throw new Error("no")
    },
  }
  assert.equal(
    await pauseInterruptRefusal(
      { ...story, agentStatus: "Paused" },
      engine,
      "darwin"
    ),
    undefined
  )
  const refused = await pauseInterruptRefusal(story, engine, "darwin")
  assert.match(String((refused?.error as Error).message), /no/)
})
