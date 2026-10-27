import assert from "node:assert/strict"
import test from "node:test"

import {
  projectInitializationAvailability,
  staleInitializationMs,
  storyInitializationDecision,
} from "./project-initialization-availability.ts"

const now = Date.parse("2026-10-28T12:00:00Z")

function initialization(
  status: "pending" | "running" | "done" | "error",
  minutesAgo = 1,
  previewManifest: unknown = status === "done" ? {} : null
) {
  return {
    projectId: "project",
    status,
    step: status,
    clineSessionId: null,
    agentProviderId: null,
    agentModelId: null,
    previewManifest,
    runConfigurations: [],
    databaseMode: null,
    error: null,
    repairReason: null,
    createdAt: new Date(now - 60 * 60_000).toISOString(),
    updatedAt: new Date(now - minutesAgo * 60_000).toISOString(),
  } as Parameters<typeof projectInitializationAvailability>[0]
}

test("only a finished initialization with a manifest is ready", () => {
  const options = { runningHere: false, now }
  assert.equal(
    projectInitializationAvailability(initialization("done"), options),
    "ready"
  )
  assert.equal(
    projectInitializationAvailability(initialization("done", 1, null), options),
    "unavailable"
  )
  assert.equal(projectInitializationAvailability(null, options), "unavailable")
  assert.equal(
    projectInitializationAvailability(initialization("error"), options),
    "unavailable"
  )
  assert.equal(
    projectInitializationAvailability(initialization("pending"), options),
    "unavailable"
  )
})

test("a run counts while it runs here or still reports", () => {
  const stale = staleInitializationMs / 60_000 + 1
  assert.equal(
    projectInitializationAvailability(initialization("running"), {
      runningHere: false,
      now,
    }),
    "running"
  )
  assert.equal(
    projectInitializationAvailability(initialization("running", stale), {
      runningHere: false,
      now,
    }),
    "unavailable"
  )
  assert.equal(
    projectInitializationAvailability(null, { runningHere: true, now }),
    "running"
  )
})

test("stories never wait on a missing initialization", () => {
  assert.equal(storyInitializationDecision("unavailable", "direct"), "start")
  assert.equal(
    storyInitializationDecision("unavailable", "local-container"),
    "run-direct"
  )
  assert.equal(storyInitializationDecision("running", "direct"), "start")
  assert.equal(storyInitializationDecision("running", "vercel-compose"), "wait")
  assert.equal(storyInitializationDecision("ready", "local-container"), "start")
})
