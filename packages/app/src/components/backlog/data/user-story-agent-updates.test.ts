import assert from "node:assert/strict"
import test from "node:test"

import type {
  UserStory,
  UserStoryAgentActivity,
  UserStoryAgentRun,
} from "./backlog-data.ts"
import {
  agentAuthenticationErrorKey,
  agentEventUpdate,
  agentRunEventUpdate,
  pendingAgentUpdate,
  runFlowState,
} from "./user-story-agent-updates.ts"

test("coalescing preserves activity order and replaces a tool's running snapshot", () => {
  const run = { id: "run-1" } as UserStoryAgentRun
  const running = { id: "tool-1", status: "running" } as UserStoryAgentActivity
  const reasoning = { id: "reasoning-1" } as UserStoryAgentActivity
  const completed = { ...running, status: "completed" as const }
  const pending = pendingAgentUpdate(
    undefined,
    {
      agentActivityUpdates: [running, reasoning],
      agentLastEvent: "Working",
    },
    run,
    { status: "running" }
  )
  const merged = pendingAgentUpdate(
    pending,
    {
      agentActivity: completed,
      agentLastEvent: "Finished",
    },
    run,
    { finalResponse: "Done" }
  )

  assert.deepEqual(merged.activities, [completed, reasoning])
  assert.equal(merged.input.agentLastEvent, "Finished")
  assert.deepEqual(merged.runInput, {
    status: "running",
    finalResponse: "Done",
  })
  assert.equal(merged.run, run)
  assert.equal(pending.activities[0].status, "running")
})

test("an expired provider token pauses a story without declaring it complete", () => {
  const text = "The authentication token was invalidated"
  const event = {
    type: "error" as const,
    payload: { error: { message: text } },
  }
  const update = agentEventUpdate({} as UserStory, event, {})
  const runUpdate = agentRunEventUpdate(update, event, text)
  assert.equal(update.agentStatus, "Paused")
  assert.equal(update.status, undefined)
  assert.equal(update.agentLastError, text)
  assert.equal(runUpdate.status, "failed")
})

test("terminal success moves the story to review and completes its run", () => {
  const event = {
    type: "done" as const,
    payload: { terminal: true, text: "Done" },
  }
  const update = agentEventUpdate({} as UserStory, event)
  const runUpdate = agentRunEventUpdate(update, event, "Done")
  assert.equal(update.status, "in-review")
  assert.equal(update.agentStatus, null)
  assert.equal(update.agentLastError, null)
  assert.equal(runUpdate.status, "completed")
  assert.ok(runUpdate.completedAt)
})

test("an expired token silences its own run, not the story's next one", () => {
  const story = { id: "story-1" }
  const first = agentAuthenticationErrorKey(story, { id: "run-1" })
  assert.equal(first, agentAuthenticationErrorKey(story, { id: "run-1" }))
  assert.notEqual(first, agentAuthenticationErrorKey(story, { id: "run-2" }))
  assert.notEqual(
    first,
    agentAuthenticationErrorKey({ id: "story-2" }, { id: "run-1" })
  )
  assert.notEqual(first, agentAuthenticationErrorKey(story))
})

test("a run's stream starts from the run's saved state, not the story's", () => {
  const activity = { id: "tool-1" } as UserStoryAgentActivity
  const usage = { inputTokens: 3 } as UserStoryAgentRun["usage"]
  const run = {
    activities: [activity],
    finalResponse: "Done",
    id: "run-1",
    sessionSummary: "Session completed.",
    usage,
  } as UserStoryAgentRun
  assert.deepEqual(runFlowState(run), {
    agentActivities: [activity],
    agentFinalResponse: "Done",
    agentSessionSummary: "Session completed.",
    agentUsage: usage,
  })
  assert.deepEqual(runFlowState({ id: "run-2" } as UserStoryAgentRun), {
    agentActivities: undefined,
    agentFinalResponse: undefined,
    agentSessionSummary: undefined,
    agentUsage: undefined,
  })
})
