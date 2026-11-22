import assert from "node:assert/strict"
import test from "node:test"
import type { SessionRecord } from "@blame/engine-client"
import { TranscriptReducer } from "@blame/engine-client/transcript"
import { orchestratorWakeText } from "@blame/agent-runtime/engine-protocol"

import {
  decisionStories,
  epicTranscript,
  openQuestion,
  personSentence,
} from "./epic-transcript.ts"

const model = { provider: "anthropic", model: "claude-sonnet-5-5" }
const usage = { input_tokens: 100, output_tokens: 20, cost_micro_usd: 3000 }
let seq = 0
function record(body: Record<string, unknown>): SessionRecord {
  seq += 1
  return {
    seq,
    at_ms: 1_700_000_000_000 + seq * 1000,
    ...body,
  } as SessionRecord
}

function open(turn: string, input: unknown[]) {
  return [
    record({ type: "user_message", turn, input, delivery: "turn" }),
    record({
      type: "request_started",
      turn,
      request: `r-${turn}`,
      model,
      attempt: 1,
      prefix_digest: "d",
    }),
  ]
}

function call(
  turn: string,
  id: string,
  name: string,
  input: unknown,
  outcome: "completed" | "failed" | "denied" | undefined,
  output = "{}",
  approval?: "approved" | "denied" | "pending"
) {
  const records = [
    record({
      type: "assistant_message",
      turn,
      request: `r-${turn}`,
      blocks: [{ type: "tool_call", call: id, name, input }],
      stop: "tool_use",
      usage,
    }),
  ]
  if (approval) {
    records.push(record({ type: "approval_requested", turn, call: id }))
    if (approval !== "pending")
      records.push(
        record({
          type: "approval_resolved",
          turn,
          call: id,
          decision: approval,
        })
      )
  }
  if (outcome && outcome !== "denied")
    records.push(
      record({
        type: "tool_call_started",
        turn,
        call: id,
        name,
        effect: "mutating",
      })
    )
  if (outcome)
    records.push(
      record({
        type: "tool_call_finished",
        turn,
        call: id,
        outcome,
        content: [{ type: "text", text: output }],
      })
    )
  return records
}

function entries(records: SessionRecord[]) {
  const reducer = new TranscriptReducer()
  reducer.applyRecords(records)
  return epicTranscript(reducer.snapshot())
}

const wake = {
  reason: "stories" as const,
  stories: [
    {
      storyId: "s1",
      number: "US-004",
      title: "Export",
      session: "x",
      turn: "t",
      outcome: "completed" as const,
      verified: true,
      status: "in-review",
    },
  ],
  board: {
    working: 0,
    queued: 1,
    held: 0,
    inReview: 1,
    paused: 0,
    merged: 0,
    rejected: 0,
  },
}

test("the person's message, the decisions and the wait, in order", () => {
  seq = 0
  const result = entries([
    ...open("t1", [{ type: "text", text: "Export orders as CSV" }]),
    record({
      type: "assistant_message",
      turn: "t1",
      request: "r-t1",
      blocks: [{ type: "text", text: "Two stories." }],
      stop: "tool_use",
      usage,
    }),
    ...call("t1", "c0", "epic_board", {}, "completed"),
    ...call(
      "t1",
      "c1",
      "create_stories",
      {
        reason: "Split it",
        stories: [{ key: "a", title: "Writer", brief: "b", intent: "cheaper" }],
      },
      "completed",
      JSON.stringify({
        created: [{ key: "a", id: "s1", number: "US-004", status: "queued" }],
      }),
      "approved"
    ),
    ...call(
      "t1",
      "c2",
      "end_turn",
      { action: "wait", reason: "Stories run" },
      "completed",
      "Waiting"
    ),
    record({
      type: "turn_ended",
      turn: "t1",
      outcome: { status: "completed" },
    }),
  ])
  assert.deepEqual(
    result.map((entry) => entry.kind),
    ["person", "message", "lookup", "decision", "end"]
  )
  const decision = result[3]
  assert.equal(decision?.kind, "decision")
  if (decision?.kind !== "decision") return
  assert.equal(decision.tool, "create_stories")
  assert.equal(decision.refusal, undefined)
  assert.deepEqual(decisionStories(decision), [{ ref: "s1", title: "Writer" }])
  const end = result[4]
  assert.equal(end?.kind === "end" && end.action, "wait")
})

test("the host's wake is an event, never the person's message", () => {
  seq = 0
  const result = entries([
    ...open("t1", [{ type: "context", text: orchestratorWakeText(wake) }]),
    record({
      type: "turn_ended",
      turn: "t1",
      outcome: { status: "completed" },
    }),
  ])
  assert.equal(result.length, 1)
  assert.equal(result[0]?.kind, "wake")
  if (result[0]?.kind === "wake")
    assert.equal(result[0].wake.stories[0]?.number, "US-004")
})

test("a refused approval carries the host's sentence", () => {
  seq = 0
  const refusal =
    "US-005's last turn did not end completed (contract_unmet: lint still fail): the harness did not accept its finish_task. Ask for changes, or reject it."
  const result = entries([
    ...open("t1", [{ type: "text", text: "go" }]),
    ...call(
      "t1",
      "c1",
      "approve_story",
      { reason: "Looks done", storyId: "US-005" },
      "failed",
      refusal,
      "approved"
    ),
  ])
  const decision = result.find((entry) => entry.kind === "decision")
  assert.equal(decision?.kind === "decision" && decision.refusal, refusal)
  if (decision?.kind === "decision")
    assert.deepEqual(decisionStories(decision), [{ ref: "US-005" }])
})

test("a call waiting for Allow, and one the person denied", () => {
  seq = 0
  const waiting = entries([
    ...open("t1", [{ type: "text", text: "go" }]),
    ...call(
      "t1",
      "c1",
      "approve_story",
      { reason: "ok", storyId: "US-004" },
      undefined,
      "",
      "pending"
    ),
  ]).find((entry) => entry.kind === "decision")
  assert.equal(
    waiting?.kind === "decision" && waiting.state,
    "awaiting_approval"
  )
  seq = 0
  const denied = entries([
    ...open("t1", [{ type: "text", text: "go" }]),
    ...call(
      "t1",
      "c1",
      "approve_story",
      { reason: "ok", storyId: "US-004" },
      "denied",
      "Denied by the user.",
      "denied"
    ),
  ]).find((entry) => entry.kind === "decision")
  assert.equal(denied?.kind === "decision" && denied.state, "denied")
  assert.equal(denied?.kind === "decision" && denied.refusal, undefined)
})

test("an ask is the open question until the person answers", () => {
  seq = 0
  const asked = [
    ...open("t1", [{ type: "text", text: "go" }]),
    ...call(
      "t1",
      "c1",
      "end_turn",
      {
        action: "ask",
        reason: "r",
        question: "CSV or XLSX?",
        options: ["CSV", "XLSX"],
      },
      "completed",
      "Asked"
    ),
    record({
      type: "turn_ended",
      turn: "t1",
      outcome: { status: "completed" },
    }),
  ]
  const question = openQuestion(entries(asked))
  assert.equal(question?.question, "CSV or XLSX?")
  assert.deepEqual(question?.options, ["CSV", "XLSX"])
  const answered = entries([
    ...asked,
    ...open("t2", [{ type: "text", text: "CSV" }]),
  ])
  assert.equal(openQuestion(answered), undefined)
})

test("a refused ending is a problem, not an ending", () => {
  seq = 0
  const result = entries([
    ...open("t1", [{ type: "text", text: "go" }]),
    ...call(
      "t1",
      "c1",
      "end_turn",
      { action: "finish", reason: "r", summary: "Done" },
      "failed",
      "Not every story is merged or rejected."
    ),
  ])
  assert.equal(result.at(-1)?.kind, "problem")
})

test("a refusal's first sentence is the person's", () => {
  assert.equal(
    personSentence(
      "US-005 is not merged: its changes conflict with the epic's branch. Ask for changes (message_story, kind changes): its agent merges epic/x."
    ),
    "US-005 is not merged: its changes conflict with the epic's branch."
  )
  assert.equal(
    personSentence("It costs $3.20 more. Stop."),
    "It costs $3.20 more."
  )
  assert.equal(personSentence("No full stop here"), "No full stop here")
})
