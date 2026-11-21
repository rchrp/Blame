import assert from "node:assert/strict"
import test from "node:test"
import type { RunAgentsResult, SessionRecord } from "@blame/engine-client"
import { TranscriptReducer } from "@blame/engine-client/transcript"

import { transcriptConversation } from "../engine/transcript-conversation.ts"
import {
  describeToolCall,
  toolCallSource,
} from "../tool-calls/describe-tool-call.ts"
import {
  formatDuration,
  formatTokens,
  readSubAgentsCall,
  subAgentRows,
  subAgentSession,
  subAgentTotals,
  summaryLine,
} from "./sub-agents-view.ts"

const model = { provider: "chatgpt", model: "gpt-5.5" }
const config = {
  purpose: "quick-chat",
  workspace_root: "/project",
  model,
  system_prompt: "",
  engine_tools: ["harness", "subagents"],
  client_tools: [],
  tool_options: {},
  limits: {},
  checkpoints: false,
}
const usage = { input_tokens: 100, output_tokens: 20 }

let seq = 0
function record(body: Record<string, unknown>): SessionRecord {
  seq += 1
  return {
    seq,
    at_ms: 1_700_000_000_000 + seq * 1000,
    ...body,
  } as SessionRecord
}

const briefs = [
  {
    role: "explore",
    title: "Where the router is wired",
    brief: "Find where routes register.",
  },
  {
    role: "research",
    title: "What changed in the SDK",
    brief: "Read the changelog.",
  },
  {
    role: "review",
    title: "Review the diff",
    brief: "Look for missed callers.",
  },
]

const result: RunAgentsResult = {
  agents: [
    {
      index: 0,
      role: "explore",
      title: briefs[0]!.title,
      status: "completed",
      session: subAgentSession("call-1", 0),
      report: {
        summary: "In router.ts.",
        references: [{ ref: "src/router.ts:12", note: "registers" }],
      },
      tokens: 4200,
      duration_ms: 12_400,
    },
    {
      index: 1,
      role: "research",
      title: briefs[1]!.title,
      status: "failed",
      session: subAgentSession("call-1", 1),
      reason: "The model failed: rate limited",
      tokens: 900,
      duration_ms: 3000,
    },
    {
      index: 2,
      role: "review",
      title: briefs[2]!.title,
      status: "cancelled",
      session: subAgentSession("call-1", 2),
      reason: "It was stopped before it reported.",
      tokens: 0,
      duration_ms: 0,
    },
  ],
  tokens: 5100,
}

/** The lead's conversation with a `run_agents` call, finished or not. */
function leadActivity(finished: "result" | "running" | "refused") {
  const records = [
    record({ type: "session_created", config }),
    record({
      type: "user_message",
      turn: "t1",
      input: [{ type: "text", text: "go" }, { type: "ultra" }],
      delivery: "turn",
    }),
    record({
      type: "request_started",
      turn: "t1",
      request: "r1",
      model,
      attempt: 1,
      prefix_digest: "d",
    }),
    record({
      type: "assistant_message",
      turn: "t1",
      request: "r1",
      blocks: [
        {
          type: "tool_call",
          call: "call-1",
          name: "run_agents",
          input: { agents: briefs },
        },
      ],
      stop: "tool_use",
      usage,
    }),
    record({
      type: "tool_call_started",
      turn: "t1",
      call: "call-1",
      name: "run_agents",
      effect: "read_only",
    }),
  ]
  if (finished === "result")
    records.push(
      record({
        type: "tool_call_finished",
        turn: "t1",
        call: "call-1",
        outcome: "completed",
        content: [{ type: "text", text: JSON.stringify(result) }],
      })
    )
  if (finished === "refused")
    records.push(
      record({
        type: "tool_call_finished",
        turn: "t1",
        call: "call-1",
        outcome: "denied",
        content: [
          {
            type: "text",
            text: "Not started: ultra mode is off for this message.",
          },
        ],
      })
    )
  const reducer = new TranscriptReducer()
  reducer.applyRecords(records)
  const run = transcriptConversation(reducer.snapshot(), "You").runs[0]!
  const activity = run.activities!.find(
    (item) => item.toolName === "run_agents"
  )!
  return {
    activity,
    comment: transcriptConversation(reducer.snapshot(), "You").comments[0]!,
  }
}

/** A helper's own session, as far as it got. */
function helper(options: {
  ended?: "completed" | "interrupted"
  tokens: number
}) {
  const turn = "h1"
  const records = [
    record({
      type: "session_created",
      config: { ...config, kind: { kind: "task" } },
    }),
    record({
      type: "user_message",
      turn,
      input: [{ type: "text", text: "brief" }],
      delivery: "turn",
    }),
    record({
      type: "request_started",
      turn,
      request: "r1",
      model,
      attempt: 1,
      prefix_digest: "d",
    }),
    record({
      type: "assistant_message",
      turn,
      request: "r1",
      blocks: [{ type: "text", text: "looking" }],
      stop: "end_turn",
      usage: { input_tokens: options.tokens, output_tokens: 0 },
    }),
  ]
  if (options.ended)
    records.push(
      record({ type: "turn_ended", turn, outcome: { status: options.ended } })
    )
  const reducer = new TranscriptReducer()
  reducer.applyRecords(records)
  return reducer.snapshot()
}

test("a finished call reads its rows from the result, and the call is the whole truth", () => {
  const { activity } = leadActivity("result")
  const call = readSubAgentsCall(activity)!
  assert.equal(call.running, false)
  const rows = subAgentRows(call, new Map(), Date.now())
  assert.deepEqual(
    rows.map((row) => [
      row.role,
      row.title,
      row.status,
      row.tokens,
      row.durationMs,
    ]),
    [
      ["explore", "Where the router is wired", "done", 4200, 12_400],
      ["research", "What changed in the SDK", "failed", 900, 3000],
      ["review", "Review the diff", "cancelled", 0, 0],
    ]
  )
  assert.equal(rows[0]!.report?.references[0]?.reference, undefined)
  assert.equal(
    rows[0]!.report?.references[0]?.["ref" as never],
    "src/router.ts:12"
  )
  assert.equal(rows[1]!.reason, "The model failed: rate limited")
  assert.equal(rows[0]!.session, "call-1.0")
  assert.deepEqual(subAgentTotals(rows), {
    tokens: 5100,
    durationMs: 12_400,
    done: 1,
    count: 3,
  })
})

test("a running call follows each helper's own records", () => {
  const { activity } = leadActivity("running")
  const call = readSubAgentsCall(activity)!
  assert.equal(call.running, true)
  assert.deepEqual(call.queued, [])
  const now = 1_700_000_000_000 + 1_000_000
  const threads = new Map([
    [0, helper({ tokens: 3000 })],
    // Ended while the lead's call has not returned yet.
    [1, helper({ tokens: 500, ended: "completed" })],
  ])
  const rows = subAgentRows(call, threads, now)
  assert.deepEqual(
    rows.map((row) => [row.status, row.tokens]),
    [
      ["running", 3000],
      ["done", 500],
      // No session yet and not waiting: it has just started.
      ["running", 0],
    ]
  )
  assert.ok(rows[0]!.durationMs > 50_000, "a running helper counts up to now")
  assert.ok(rows[1]!.durationMs < 10_000, "an ended one stops at its end")
})

test("helpers the call reports as waiting are waiting", () => {
  const { activity } = leadActivity("running")
  const call = { ...readSubAgentsCall(activity)!, queued: [2] }
  const rows = subAgentRows(call, new Map(), Date.now())
  assert.deepEqual(
    rows.map((row) => row.status),
    ["running", "running", "waiting"]
  )
  assert.equal(summaryLine(subAgentTotals(rows), true), "0 of 3 done")
})

test("an interrupted helper reads as stopped, not failed", () => {
  const { activity } = leadActivity("running")
  const call = readSubAgentsCall(activity)!
  const rows = subAgentRows(
    call,
    new Map([[0, helper({ tokens: 10, ended: "interrupted" })]]),
    Date.now()
  )
  assert.equal(rows[0]!.status, "cancelled")
})

test("a call the engine refused is an ordinary step with the reason", () => {
  const { activity } = leadActivity("refused")
  assert.equal(readSubAgentsCall(activity), undefined)
  const view = describeToolCall(toolCallSource(activity, false))
  assert.equal(view.verb, "Did not start")
  assert.equal(view.target?.text, "3 helper agents")
  assert.deepEqual(view.bodies, [
    { type: "text", text: "Not started: ultra mode is off for this message." },
  ])
})

test("a call still streaming its input is a step too", () => {
  const view = describeToolCall(
    toolCallSource(
      {
        kind: "tool",
        title: "run_agents",
        detail: JSON.stringify({
          toolName: "run_agents",
          input: { agents: [briefs[0]] },
        }),
      },
      true
    )
  )
  assert.equal(view.verb, "Starting")
  assert.equal(view.target?.text, "1 helper agent")
})

test("a message sent in ultra mode carries the marker, the others do not", () => {
  const { comment } = leadActivity("running")
  assert.equal(comment.ultra, true)
  const reducer = new TranscriptReducer()
  reducer.applyRecords([
    record({ type: "session_created", config }),
    record({
      type: "user_message",
      turn: "t9",
      input: [{ type: "text", text: "plain" }],
      delivery: "turn",
    }),
  ])
  assert.equal(
    transcriptConversation(reducer.snapshot(), "You").comments[0]!.ultra,
    undefined
  )
})

test("numbers read at a glance", () => {
  assert.equal(formatTokens(0), "0")
  assert.equal(formatTokens(999), "999")
  assert.equal(formatTokens(1200), "1.2k")
  assert.equal(formatTokens(38_400), "38k")
  assert.equal(formatTokens(1_400_000), "1.4M")
  assert.equal(formatDuration(0), "<1 s")
  assert.equal(formatDuration(12_400), "12 s")
  assert.equal(formatDuration(125_000), "2 min 5 s")
})
