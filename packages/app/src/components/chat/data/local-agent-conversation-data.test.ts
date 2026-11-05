import assert from "node:assert/strict"
import test from "node:test"

import type { UserStoryAgentActivity } from "../../backlog/data/backlog-data.ts"
import type { AgentConversationRun } from "../agent-conversation.tsx"
import {
  appendTurn,
  applyStreamSnapshot,
  emptyLocalConversation,
  endRun,
  loadLocalConversation,
  resumableRuns,
  saveLocalConversation,
  settleInterruptedRuns,
} from "./local-agent-conversation-data.ts"

const run: AgentConversationRun = {
  activities: [],
  createdAt: "2026-11-03T10:00:00Z",
  id: "run-1",
  kind: "change-request",
  messageId: "comment-1",
  status: "running",
}
const comment = {
  author: "You",
  body: "Plan an export",
  createdAt: "2026-11-03T10:00:00Z",
  id: "comment-1",
}

function activity(
  id: string,
  detail: string,
  status: UserStoryAgentActivity["status"] = "completed"
): UserStoryAgentActivity {
  return {
    createdAt: "2026-11-03T10:00:01Z",
    detail,
    id,
    kind: "tool",
    status,
    title: id,
    toolName: id,
  }
}

test("keeps the full copy of each step while the stream sends compact ones", () => {
  let conversation = appendTurn(emptyLocalConversation(), comment, run)
  conversation = applyStreamSnapshot(
    conversation,
    "run-1",
    {
      agentActivities: [activity("propose_user_stories", "short")],
      agentActivity: activity("propose_user_stories", "the full proposal"),
    },
    { payload: {}, type: "tool" }
  )
  conversation = applyStreamSnapshot(
    conversation,
    "run-1",
    {
      agentActivities: [
        activity("propose_user_stories", "short"),
        activity("read_code", "x", "running"),
      ],
      agentActivity: activity("read_code", "x", "running"),
    },
    { payload: {}, type: "tool" }
  )
  const activities = conversation.runs[0]!.activities!
  assert.equal(activities[0]!.detail, "the full proposal")
  assert.equal(activities[1]!.detail, "x")
  assert.equal(conversation.runs[0]!.status, "running")
})

test("the last event ends the turn and settles its running steps", () => {
  const conversation = applyStreamSnapshot(
    appendTurn(emptyLocalConversation(), comment, run),
    "run-1",
    {
      agentActivities: [activity("run_task", "x", "running")],
      agentFinalResponse: "Here are three stories.",
    },
    { payload: {}, type: "done" }
  )
  const ended = conversation.runs[0]!
  assert.equal(ended.status, "completed")
  assert.equal(ended.finalResponse, "Here are three stories.")
  assert.ok(ended.completedAt)
  assert.equal(ended.activities![0]!.status, "failed")
  // A finished turn ignores late events.
  assert.equal(
    applyStreamSnapshot(
      conversation,
      "run-1",
      {},
      {
        payload: { message: "late" },
        type: "error",
      }
    ),
    conversation
  )
})

test("a stopped or interrupted turn is cancelled, a finished one untouched", () => {
  const conversation = appendTurn(emptyLocalConversation(), comment, run)
  const stopped = endRun(conversation, "run-1", "cancelled", "You stopped it.")
  assert.equal(stopped.runs[0]!.status, "cancelled")
  assert.equal(stopped.runs[0]!.finalResponse, "You stopped it.")
  assert.equal(endRun(stopped, "run-1", "failed", "x"), stopped)
  const restored = settleInterruptedRuns(conversation)
  assert.equal(restored.runs[0]!.status, "cancelled")
  assert.equal(restored.runs[0]!.finalResponse, "The agent was interrupted.")
})

test("a reload keeps the latest running turn for the app to follow again", () => {
  const storage = new Map<string, string>()
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => void storage.delete(key),
    setItem: (key: string, value: string) => void storage.set(key, value),
  } as Storage
  try {
    const earlier = { ...run, id: "run-0", messageId: "comment-0" }
    const latest = {
      ...run,
      clineSessionId: "session",
      executionId: "execution",
      lastSequenceNumber: 12,
    }
    const conversation = appendTurn(
      appendTurn(
        emptyLocalConversation(),
        { ...comment, id: "comment-0" },
        earlier
      ),
      comment,
      latest
    )
    saveLocalConversation("plan", conversation)

    const loaded = loadLocalConversation("plan")

    assert.equal(loaded.runs[0]!.status, "cancelled")
    assert.equal(loaded.runs[1]!.status, "running")
    assert.equal(loaded.runs[1]!.lastSequenceNumber, 12)
    assert.deepEqual(
      resumableRuns(loaded).map((item) => item.id),
      ["run-1"]
    )
  } finally {
    globalThis.localStorage = previous
  }
})

test("a snapshot records how far the stream was saved", () => {
  const conversation = appendTurn(emptyLocalConversation(), comment, run)
  const next = applyStreamSnapshot(
    conversation,
    "run-1",
    { agentActivities: [activity("read", "x")] },
    { payload: {}, type: "tool" } as never,
    { lastSequenceNumber: 7 }
  )
  assert.equal(next.runs[0]!.lastSequenceNumber, 7)
  assert.equal(resumableRuns(endRun(next, "run-1", "failed", "x")).length, 0)
})
