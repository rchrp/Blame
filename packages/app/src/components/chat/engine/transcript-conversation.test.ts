import assert from "node:assert/strict"
import test from "node:test"
import type { Delta, SessionRecord } from "@blame/engine-client"
import { TranscriptReducer } from "@blame/engine-client/transcript"

import { transcriptConversation } from "./transcript-conversation.ts"

const model = { provider: "chatgpt", model: "gpt-5.5" }
const config = {
  purpose: "quick-chat",
  workspace_root: "/project",
  model,
  system_prompt: "",
  engine_tools: ["harness"],
  client_tools: [],
  tool_options: {},
  limits: {},
  checkpoints: true,
}
const usage = { input_tokens: 100, output_tokens: 20, cost_micro_usd: 3000 }

let seq = 0
function record(body: Record<string, unknown>): SessionRecord {
  seq += 1
  return { seq, at_ms: 1_700_000_000_000 + seq * 1000, ...body } as SessionRecord
}

function turn(id: string, text: string, reply: string, tool?: string) {
  const records = [
    record({ type: "user_message", turn: id, input: [{ type: "text", text }], delivery: "turn" }),
    record({ type: "checkpoint_created", turn: id, checkpoint: `cp-${id}`, snapshot: "tree" }),
    record({ type: "request_started", turn: id, request: `r1-${id}`, model, attempt: 1, prefix_digest: "d" }),
  ]
  if (tool)
    records.push(
      record({
        type: "assistant_message",
        turn: id,
        request: `r1-${id}`,
        blocks: [{ type: "tool_call", call: `call-${id}`, name: tool, input: { query: "engine" } }],
        stop: "tool_use",
        usage,
      }),
      record({ type: "tool_call_started", turn: id, call: `call-${id}`, name: tool, effect: "read_only" }),
      record({
        type: "tool_call_finished",
        turn: id,
        call: `call-${id}`,
        outcome: "completed",
        content: [{ type: "text", text: '{"kind":"web_search","sources":[]}' }],
      }),
      record({ type: "request_started", turn: id, request: `r2-${id}`, model, attempt: 1, prefix_digest: "d" })
    )
  records.push(
    record({
      type: "assistant_message",
      turn: id,
      request: tool ? `r2-${id}` : `r1-${id}`,
      blocks: [{ type: "text", text: reply }],
      stop: "end_turn",
      usage,
    }),
    record({ type: "turn_ended", turn: id, outcome: { status: "completed" } })
  )
  return records
}

function conversation(records: SessionRecord[], deltas: Delta[] = []) {
  const reducer = new TranscriptReducer()
  reducer.applyRecords(records)
  for (const delta of deltas) reducer.applyDelta(delta)
  return transcriptConversation(reducer.snapshot(), "You")
}

test("each turn is the person's message and what the agent did for it", () => {
  seq = 0
  const result = conversation([
    record({ type: "session_created", config }),
    ...turn("t1", "find the engine", "Found it.", "search_web"),
    ...turn("t2", "thanks", "You're welcome."),
  ])
  assert.deepEqual(
    result.comments.map((comment) => comment.body),
    ["find the engine", "thanks"]
  )
  const [first, second] = result.runs
  assert.equal(first!.status, "completed")
  assert.equal(first!.commentId, result.comments[0]!.id)
  assert.equal(first!.providerId, "openai-codex", "the app's provider id")
  assert.equal(first!.finalResponse, "Found it.")
  const tool = first!.activities!.find((activity) => activity.kind === "tool")!
  assert.equal(tool.toolName, "search_web")
  assert.equal(tool.status, "completed")
  assert.deepEqual(JSON.parse(tool.detail), {
    toolName: "search_web",
    input: { query: "engine" },
    output: { kind: "web_search", sources: [] },
    durationMs: 1000,
  })
  assert.equal(
    first!.activities!.at(-1)!.messageKind,
    "final",
    "the reply answers the message"
  )
  assert.equal(second!.checkpointRunCount, 2)
  assert.equal(
    result.rewindTargets.get(result.comments[1]!.id)?.workspace,
    true,
    "a turn with a checkpoint can be undone with its files"
  )
  assert.equal(first!.usage?.totalCost, 0.009)
})

test("a running turn shows what streams, and a queued message waits", () => {
  seq = 0
  const result = conversation(
    [
      record({ type: "session_created", config }),
      record({ type: "user_message", turn: "t1", input: [{ type: "text", text: "go" }], delivery: "turn" }),
      record({ type: "request_started", turn: "t1", request: "r1", model, attempt: 1, prefix_digest: "d" }),
      record({ type: "user_message", turn: "t2", input: [{ type: "text", text: "then this" }], delivery: "turn" }),
    ],
    [
      { type: "activity", activity: { state: "streaming" } },
      { type: "block_started", request: "r1", index: 0, kind: "text" },
      { type: "text", request: "r1", index: 0, text: "Working on" },
    ]
  )
  assert.deepEqual(
    result.runs.map((run) => run.status),
    ["running", "pending"]
  )
  const live = result.runs[0]!.activities!.at(-1)!
  assert.equal(live.detail, "Working on")
  assert.equal(live.status, "running")
  assert.equal(live.messageKind, "intermediate")
})

test("a failed turn ends on its error", () => {
  seq = 0
  const result = conversation([
    record({ type: "session_created", config }),
    record({ type: "user_message", turn: "t1", input: [{ type: "text", text: "go" }], delivery: "turn" }),
    record({
      type: "turn_ended",
      turn: "t1",
      outcome: { status: "failed", error: { kind: "authentication", message: "Sign in to ChatGPT again." } },
    }),
  ])
  assert.equal(result.runs[0]!.status, "failed")
  const error = result.runs[0]!.activities!.at(-1)!
  assert.equal(error.kind, "error")
  assert.equal(error.detail, "Sign in to ChatGPT again.")
})
