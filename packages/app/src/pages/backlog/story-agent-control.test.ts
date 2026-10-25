import assert from "node:assert/strict"
import test from "node:test"

import type {
  UserStory,
  UserStoryAgentRun,
  UserStoryAgentRunFinalization,
} from "../../components/backlog/data/backlog-data.ts"
import {
  closeStoryRunStreams,
  registerRunStream,
  runStreamOpen,
} from "../../components/backlog/data/agent-run-streams.ts"
import { AgentStreamCoordinator } from "../../components/backlog/data/agent-stream-coordinator.ts"
import { AgentStreamStore } from "../../components/backlog/data/agent-stream-store.ts"
import { finalizeStoppedRun } from "./story-agent-control.ts"

for (const message of ["Interrupted by your comment.", "Paused by you."]) {
  test(`persists the stopped execution: ${message}`, async () => {
    const run = runningRun()
    const stale = storyWith({ ...run, lastSequenceNumber: 2 })
    const current = storyWith(run)
    const paused = { ...current, agentStatus: "Paused" }
    let finalization: UserStoryAgentRunFinalization | undefined
    const result = await finalizeStoppedRun(
      {
        async loadDetail(story) {
          assert.equal(story, stale)
          return current
        },
        async finalizeAgentRun(story, stopped, input) {
          assert.equal(story, current)
          assert.equal(stopped, run)
          finalization = input
          return paused
        },
      },
      stale,
      message
    )

    assert.equal(result, paused)
    assert.equal(finalization?.status, "cancelled")
    assert.equal(finalization?.outcome, "paused")
    assert.equal(finalization?.agentLastEvent, message)
    assert.equal(finalization?.agentLastError, null)
    const event = finalization?.persistenceEvent
    assert.ok(event, "stopping an execution requires a persistence event")
    assert.equal(event.runId, run.id)
    assert.equal(event.executionId, run.executionId)
    assert.equal(event.sessionId, run.clineSessionId)
    assert.equal(event.sequenceNumber, 8)
    assert.equal(event.eventType, "done")
    assert.equal(event.createdAt, finalization?.completedAt)
    assert.ok(Number.isFinite(Date.parse(event.createdAt)))
    assert.ok(event.eventId)
  })
}

test("uses the active run even when another running run appears last", async () => {
  const active = runningRun()
  const current = storyWith(active)
  current.agentRuns?.push(runningRun())
  await finalizeStoppedRun(
    {
      loadDetail: async () => current,
      async finalizeAgentRun(_story, run) {
        assert.equal(run, active)
        return current
      },
    },
    current,
    "Paused by you."
  )
})

test("does not cancel a run that completed before its detail was loaded", async () => {
  const run = runningRun()
  const stale = storyWith(run)
  const completed = storyWith({ ...run, status: "completed" })
  completed.activeAgentRunId = null
  const result = await finalizeStoppedRun(
    {
      loadDetail: async () => completed,
      finalizeAgentRun: async () =>
        assert.fail("completed run must stay completed"),
    },
    stale,
    "Interrupted by your comment."
  )
  assert.equal(result, undefined)
})

test("uses legacy identity fallbacks when the run has no execution or session", async () => {
  const run = runningRun()
  run.executionId = null
  run.clineSessionId = null
  run.lastSequenceNumber = undefined
  const current = storyWith(run)
  await finalizeStoppedRun(
    {
      loadDetail: async () => current,
      async finalizeAgentRun(_story, _run, input) {
        assert.equal(input.persistenceEvent?.executionId, run.id)
        assert.equal(input.persistenceEvent?.sessionId, current.clineSessionId)
        assert.equal(input.persistenceEvent?.sequenceNumber, 1)
        return current
      },
    },
    current,
    "Paused by you."
  )
})

test("saves buffered response text before choosing the stop event sequence", async () => {
  const run = runningRun()
  const current = storyWith(run)
  const operations: string[] = []
  const coordinator = new AgentStreamCoordinator({
    executionId: run.executionId!,
    initialState: {},
    lastSequenceNumber: run.lastSequenceNumber,
    runId: run.id,
    sessionId: run.clineSessionId!,
    store: new AgentStreamStore(),
    async persist(snapshot) {
      operations.push("snapshot")
      run.lastSequenceNumber = snapshot.persistenceEvent.sequenceNumber
      run.activities = snapshot.update.agentActivities
    },
  })
  registerRunStream(
    run.id,
    current.id,
    () => {
      void coordinator.disconnect()
    },
    () => coordinator.flush()
  )
  await coordinator.push({
    payload: { text: "A response interrupted while streaming" },
    sequenceNumber: 20,
    type: "text",
  })
  try {
    await finalizeStoppedRun(
      {
        async loadDetail() {
          operations.push("detail")
          return current
        },
        async finalizeAgentRun(_story, _run, input) {
          operations.push("cancelled")
          assert.equal(input.persistenceEvent?.sequenceNumber, 21)
          assert.equal(
            run.activities?.at(-1)?.detail,
            "A response interrupted while streaming"
          )
          return current
        },
      },
      current,
      "Interrupted by your comment."
    )
    assert.equal(runStreamOpen(run.id), false)
    assert.deepEqual(operations, ["snapshot", "detail", "cancelled"])
  } finally {
    closeStoryRunStreams(current.id)
    await coordinator.disconnect()
  }
})

function runningRun(): UserStoryAgentRun {
  return {
    clineSessionId: "run-session",
    createdAt: "2026-10-25T00:00:00.000Z",
    executionId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    kind: "initial",
    lastSequenceNumber: 7,
    status: "running",
    userStoryId: "story-1",
  }
}

function storyWith(run: UserStoryAgentRun): UserStory {
  return {
    activeAgentRunId: run.id,
    agentRuns: [run],
    clineSessionId: "story-session",
    createdAt: run.createdAt,
    id: run.userStoryId,
    owner: "Product",
    priority: "Medium",
    projectId: "project-1",
    status: "in-progress",
    storyNumber: 1,
    summary: "",
    title: "Story",
  }
}
