import assert from "node:assert/strict"
import test from "node:test"

import { nativePreviewLoadDecision } from "./native-preview-load.ts"

const url = "http://localhost:57824/"

test("a new story's preview loads in its own browser once its address arrives", () => {
  // Before the address, the panel renders without one: nothing to load.
  assert.equal(
    nativePreviewLoadDecision({
      browserId: "a",
      session: { browserId: "a" },
      source: "",
      sourceChanged: false,
    }),
    "skip"
  )
  // The address arrives: the session key changes while the browser id is
  // still the previous session's, and the new session has no browser yet.
  const session: { browserId?: string; source?: string } = {}
  assert.equal(
    nativePreviewLoadDecision({
      browserId: "a",
      session,
      source: url,
      sourceChanged: true,
    }),
    "skip"
  )
  // Its own browser is ready: it loads.
  session.browserId = "b"
  assert.equal(
    nativePreviewLoadDecision({
      browserId: "b",
      session,
      source: url,
      sourceChanged: true,
    }),
    "load"
  )
})

test("a reopened preview keeps its page unless it failed or moved", () => {
  const loaded = { browserId: "b", source: url, state: {} }
  const decide = (session: typeof loaded & { state: { error?: string } }) =>
    nativePreviewLoadDecision({
      browserId: "b",
      session,
      source: url,
      sourceChanged: false,
    })
  assert.equal(decide(loaded), "reuse")
  assert.equal(decide({ ...loaded, state: { error: "timed out" } }), "load")
  assert.equal(decide({ ...loaded, source: "http://localhost:3000/" }), "load")
})
