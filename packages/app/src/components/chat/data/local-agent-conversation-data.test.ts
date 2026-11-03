import assert from "node:assert/strict"
import test from "node:test"

import type { UserStoryAgentActivity } from "../../backlog/data/backlog-data.ts"
import type { AgentConversationRun } from "../agent-conversation.tsx"
import {
  appendTurn,
  applyStreamSnapshot,
  emptyLocalConversation,
  endRun,
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
