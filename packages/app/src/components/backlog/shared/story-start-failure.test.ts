import assert from "node:assert/strict"
import test from "node:test"

import { storyStartFailure } from "./story-start-failure.ts"

test("a queued story shows why its agent did not start", () => {
  assert.equal(
    storyStartFailure({
      agentLastError:
        "Error invoking remote method 'agent:sessions:start-development': Error: Another Blame runtime is using port 25463 on this Mac.",
      status: "ready",
    }),
    "Couldn't start the agent: Another Blame runtime is using port 25463 on this Mac."
  )
  assert.equal(
    storyStartFailure({
      agentLastError:
        "Cline runtime backend unavailable in BlameRuntime.\n  Hub connection closed (code=1006)\n",
      status: "ready",
    }),
    "Couldn't start the agent: Cline runtime backend unavailable in BlameRuntime. Hub connection closed (code=1006)"
  )
})

test("other stories and empty errors show nothing", () => {
  assert.equal(
    storyStartFailure({ agentLastError: "Run failed", status: "in-progress" }),
    undefined
  )
  assert.equal(
    storyStartFailure({ agentLastError: null, status: "ready" }),
    undefined
  )
  assert.equal(
    storyStartFailure({ agentLastError: " \n ", status: "ready" }),
    undefined
  )
})
