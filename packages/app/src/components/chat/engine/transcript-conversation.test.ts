import assert from "node:assert/strict"
import test from "node:test"
import type { Delta, SessionRecord } from "@blame/engine-client"
import { TranscriptReducer } from "@blame/engine-client/transcript"

import { transcriptConversation } from "./transcript-conversation.ts"
import { screenshotItemsFromActivities } from "../screenshots/screenshot-items.ts"
import { readEngineImage } from "../screenshots/engine-image.ts"
import {
  describeToolCall,
  toolCallSource,
} from "../tool-calls/describe-tool-call.ts"

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

test("a capture loads when its blob arrives after the tool record", async (t) => {
  const id = "a".repeat(64)
  const replies = [
    new Response(null, { status: 404 }),
    new Response("image", { headers: { "x-blob-media-type": "image/png" } }),
  ]
  const fetchImage = t.mock.method(globalThis, "fetch", async () => {
    const response = replies.shift()
    assert.ok(response, "unexpected blob request")
    return response
  })
  const image = await readEngineImage({ url: "https://example.invalid" }, id, new AbortController().signal)
  assert.equal(image?.type, "image/png")
  assert.equal(fetchImage.mock.callCount(), 2)
})

test("the tool gallery includes every capture in conversation order without duplicates", () => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map((char) => char.repeat(64))
  const ref = (id: string) => ({ type: "screenshot_ref", id, width: 390 })
  const items = screenshotItemsFromActivities([
    { kind: "tool", detail: JSON.stringify({ output: [ref(a), ref(b)] }) },
    { kind: "tool", detail: "", images: [{ id: c, caption: "Light" }, { id: d, caption: "Dark" }] },
    { kind: "tool", detail: "", images: [{ id: a, caption: "Light" }] },
    { kind: "message", detail: "", images: [{ id: "e".repeat(64), caption: "Final reply" }] },
  ])
  assert.deepEqual(items.map((item) => item.id), [a, b, c, d])
  assert.equal(items[0]?.blob, true)
  assert.equal(items[0]?.ref?.width, 390)
  assert.equal(items[2]?.caption, "Light")
})

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
  assert.equal(first!.providerId, "chatgpt", "the engine's id, the app's too")
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
  // The queued message is not a turn yet: it waits, with its controls.
  assert.deepEqual(
    result.runs.map((run) => run.status),
    ["running"]
  )
  assert.deepEqual(
    result.queued.map((queued) => [queued.turn, queued.comment.body, queued.editable]),
    [["t2", "then this", true]]
  )
  assert.equal(result.comments.length, 1)
  const live = result.runs[0]!.activities!.at(-1)!
  assert.equal(live.detail, "Working on")
  assert.equal(live.status, "running")
  assert.equal(live.messageKind, "intermediate")
})

// A turn the person steers: work, their message, the acknowledgement with
// the next call, more work, the reply.
function steeredTurn(through: "steer" | "acknowledged" | "ended") {
  const records = [
    record({ type: "session_created", config }),
    record({ type: "user_message", turn: "t1", input: [{ type: "text", text: "build it" }], delivery: "turn" }),
    record({ type: "request_started", turn: "t1", request: "r1", model, attempt: 1, prefix_digest: "d" }),
    record({
      type: "assistant_message", turn: "t1", request: "r1", stop: "tool_use", usage,
      blocks: [{ type: "tool_call", call: "c1", name: "run_command", input: { command: "test" } }],
    }),
    record({ type: "tool_call_started", turn: "t1", call: "c1", name: "run_command", effect: "mutating" }),
    record({ type: "user_message", turn: "t1", input: [{ type: "text", text: "check the docs too" }], delivery: "steer" }),
    record({ type: "tool_call_finished", turn: "t1", call: "c1", outcome: "completed", content: [{ type: "text", text: "ok" }] }),
    record({ type: "request_started", turn: "t1", request: "r2", model, attempt: 1, prefix_digest: "d" }),
  ]
  if (through === "steer") return records
  records.push(
    record({
      type: "assistant_message", turn: "t1", request: "r2", stop: "tool_use", usage,
      blocks: [
        { type: "text", text: "Noted, I will check the docs too." },
        { type: "tool_call", call: "c2", name: "read_file", input: { path: "docs.md" } },
      ],
    }),
    record({ type: "tool_call_started", turn: "t1", call: "c2", name: "read_file", effect: "read_only" }),
    record({ type: "tool_call_finished", turn: "t1", call: "c2", outcome: "completed", content: [{ type: "text", text: "docs" }] }),
    record({ type: "request_started", turn: "t1", request: "r3", model, attempt: 1, prefix_digest: "d" }),
  )
  if (through === "acknowledged") return records
  records.push(
    record({
      type: "assistant_message", turn: "t1", request: "r3", stop: "end_turn", usage,
      blocks: [{ type: "text", text: "Built, and the docs agree." }],
    }),
    record({ type: "turn_ended", turn: "t1", outcome: { status: "completed" } })
  )
  return records
}

test("a message sent into the running turn is the person's own, where it joined", () => {
  seq = 0
  // Live: the steer has joined and the acknowledgement streams.
  const live = conversation(steeredTurn("steer"), [
    { type: "activity", activity: { state: "streaming" } },
    { type: "block_started", request: "r2", index: 0, kind: "text" },
    { type: "text", request: "r2", index: 0, text: "Noted, I will" },
  ])
  assert.equal(live.runs.length, 1, "one run around it")
  assert.equal(live.comments.length, 1)
  const liveKinds = live.runs[0]!.activities!.map((activity) => activity.kind)
  assert.deepEqual(liveKinds, ["tool", "user", "message"])
  const steer = live.runs[0]!.activities![1]!
  assert.equal(steer.title, "You")
  assert.equal(steer.detail, "check the docs too")
  assert.equal(steer.status, "completed", "a request has given it to the model")
  assert.equal(live.runs[0]!.activities![2]!.messageKind, "intermediate")

  // Sent now while a request runs: it waits, shown, for the next one.
  seq = 0
  const waiting = conversation(
    steeredTurn("steer").filter((r) => !(r.type === "request_started" && r.request === "r2"))
  )
  const pending = waiting.runs[0]!.activities!.find((activity) => activity.kind === "user")!
  assert.equal(pending.detail, "check the docs too")
  assert.equal(pending.status, "running")

  // Replayed after the turn: same place, and the acknowledgement is not
  // the turn's reply.
  seq = 0
  const replayed = conversation(steeredTurn("ended"))
  const run = replayed.runs[0]!
  assert.deepEqual(
    run.activities!.map((activity) => [activity.kind, activity.detail]),
    [
      ["tool", run.activities![0]!.detail],
      ["user", "check the docs too"],
      ["message", "Noted, I will check the docs too."],
      ["tool", run.activities![3]!.detail],
      ["message", "Built, and the docs agree."],
    ]
  )
  assert.equal(run.activities![2]!.messageKind, "intermediate")
  assert.equal(run.finalResponse, "Built, and the docs agree.")
  assert.equal(replayed.queued.length, 0)
})

test("a queued message taken back disappears; one sent now shows once, as a steer", () => {
  seq = 0
  const base = steeredTurn("acknowledged").filter(
    (r) => !(r.type === "user_message" && r.delivery === "steer")
  )
  const result = conversation([
    ...base,
    record({ type: "user_message", turn: "t2", input: [{ type: "text", text: "never mind" }], delivery: "turn" }),
    record({ type: "user_message", turn: "t3", input: [{ type: "text", text: "now please" }], delivery: "turn" }),
    record({ type: "turn_ended", turn: "t2", outcome: { status: "withdrawn" } }),
    record({ type: "turn_ended", turn: "t3", outcome: { status: "withdrawn" } }),
    record({ type: "user_message", turn: "t1", input: [{ type: "text", text: "now please" }], delivery: "steer" }),
  ])
  assert.equal(result.runs.length, 1)
  assert.equal(result.queued.length, 0)
  const texts = result.runs[0]!.activities!
    .filter((activity) => activity.kind === "user")
    .map((activity) => activity.detail)
  assert.deepEqual(texts, ["now please"])
  assert.ok(!JSON.stringify(result).includes("never mind"))
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

test("a model the provider refuses says so once, in the engine's words", () => {
  seq = 0
  const message =
    "Anthropic does not offer the model `claude-brand-new-1`. It answered: \"model: claude-brand-new-1 (HTTP 404)\". Choose another model and send your message again."
  const error = { kind: "model_unavailable", message }
  const result = conversation([
    record({ type: "session_created", config }),
    record({ type: "user_message", turn: "t1", input: [{ type: "text", text: "go" }], delivery: "turn" }),
    record({ type: "request_started", turn: "t1", request: "r1", model, attempt: 1, prefix_digest: "d" }),
    record({ type: "request_failed", turn: "t1", request: "r1", error }),
    record({ type: "turn_ended", turn: "t1", outcome: { status: "failed", error } }),
  ])
  const errors = result.runs[0]!.activities!.filter((activity) => activity.kind === "error")
  assert.equal(errors.length, 1)
  assert.equal(errors[0]!.title, "Model not available")
  assert.equal(errors[0]!.detail, message)
})

test("a used-up plan says when it resets and where to choose another model, once", () => {
  seq = 0
  const error = {
    kind: "usage_limit",
    message:
      "Your Claude Code usage for `claude-opus-5` is used up until it resets: \"You've hit your session limit · resets 1:10am (Europe/Bucharest)\". Choose another model, or wait for the reset.",
  }
  const result = conversation([
    record({ type: "session_created", config }),
    record({ type: "user_message", turn: "t1", input: [{ type: "text", text: "go" }], delivery: "turn" }),
    record({ type: "request_started", turn: "t1", request: "r1", model, attempt: 1, prefix_digest: "d" }),
    record({ type: "request_failed", turn: "t1", request: "r1", error }),
    record({ type: "turn_ended", turn: "t1", outcome: { status: "failed", error } }),
  ])
  const errors = result.runs[0]!.activities!.filter((activity) => activity.kind === "error")
  assert.equal(errors.length, 1)
  assert.equal(errors[0]!.title, "Usage limit reached")
  assert.equal(errors[0]!.action, "choose-model")
  // Claude Code's own "resets 1:10am (Europe/Bucharest)" becomes the time.
  assert.match(
    errors[0]!.detail,
    /^claude-opus-5 is used up until .+\. To keep going now, pick another model in the message box\.$/
  )
  assert.doesNotMatch(errors[0]!.detail, /said|“/)
})

test("a turn the agent did not finish keeps its own message, not a limit's", () => {
  seq = 0
  const result = conversation([
    record({ type: "session_created", config }),
    record({ type: "user_message", turn: "t1", input: [{ type: "text", text: "go" }], delivery: "turn" }),
    record({ type: "turn_ended", turn: "t1", outcome: { status: "contract_unmet" } }),
  ])
  const error = result.runs[0]!.activities!.at(-1)!
  assert.equal(error.title, "Not finished")
  assert.equal(error.action, undefined)
})

test("an unfinished orchestrator turn names the epic tool in the shared timeline", () => {
  const result = conversation([
    record({ type: "session_created", config: { ...config, purpose: "orchestrator" } }),
    record({ type: "user_message", turn: "epic", input: [{ type: "text", text: "go" }], delivery: "turn" }),
    record({ type: "turn_ended", turn: "epic", outcome: { status: "contract_unmet" } }),
  ])
  assert.match(result.runs[0]!.activities!.at(-1)!.detail, /end_turn/)
})

test("an epic's introduction stays before its launch when the completed turn is replayed", () => {
  seq = 0
  const blocks = [
    { type: "text", text: "I’ll start the exporter." },
    { type: "tool_call", call: "launch", name: "create_stories", input: {} },
    { type: "tool_call", call: "end", name: "end_turn", input: { action: "wait" } },
  ]
  const turn = "epic"
  const [run] = conversation([
    record({ type: "session_created", config: { ...config, purpose: "orchestrator" } }),
    record({ type: "user_message", turn, delivery: "turn", input: [{ type: "text", text: "Export orders" }] }),
    record({ type: "request_started", turn, request: "r", model, attempt: 1, prefix_digest: "d" }),
    record({ type: "assistant_message", turn, request: "r", stop: "tool_use", usage, blocks }),
    ...["launch", "end"].map(call => record({ type: "tool_call_finished", turn, call, outcome: "completed", content: [] })),
    record({ type: "turn_ended", turn, outcome: { status: "completed" } }),
  ]).runs
  assert.deepEqual(run?.activities?.map(activity => activity.toolName ?? activity.detail), [
    "I’ll start the exporter.", "create_stories", "end_turn",
  ])
  assert.equal(run?.finalResponse, null)
})

test("an epic's answer after its tool calls gets the shared final response", () => {
  const turn = "epic"
  const reply = "The exporter is ready for review."
  const blocks = [
    { type: "tool_call", call: "board", name: "epic_board", input: {} },
    { type: "text", text: reply },
    { type: "tool_call", call: "end", name: "end_turn", input: { action: "reply" } },
  ]
  const [run] = conversation([
    record({ type: "session_created", config: { ...config, purpose: "orchestrator" } }),
    record({ type: "user_message", turn, delivery: "turn", input: [{ type: "text", text: "How is the exporter?" }] }),
    record({ type: "request_started", turn, request: "r", model, attempt: 1, prefix_digest: "d" }),
    record({ type: "assistant_message", turn, request: "r", stop: "tool_use", usage, blocks }),
    ...["board", "end"].map(call => record({ type: "tool_call_finished", turn, call, outcome: "completed", content: [] })),
    record({ type: "turn_ended", turn, outcome: { status: "completed" } }),
  ]).runs
  assert.equal(run?.finalResponse, reply)
  assert.deepEqual(run?.activities?.map(activity => activity.toolName ?? activity.messageKind), [
    "epic_board", "end_turn", "final",
  ])
})

test("an accepted finish supplies exactly one final reply in every conversation mode", () => {
  const summary = "The harness uses JSON-lines."
  // "plan": a Plan Mode conversation an engine store may still hold.
  for (const purpose of ["quick-chat", "development-story", "new-project", "orchestrator", "plan"]) {
    for (const progress of [undefined, "I’ll check the harness.", summary]) {
      seq = 0
      const records = [
        record({ type: "session_created", config: { ...config, purpose } }),
        record({ type: "user_message", turn: "t", delivery: "turn", input: [{ type: "text", text: "Inspect it" }] }),
        record({ type: "request_started", turn: "t", request: "r", model, attempt: 1, prefix_digest: "d" }),
        record({
          type: "assistant_message", turn: "t", request: "r", stop: "tool_use", usage,
          blocks: [
            ...(progress ? [{ type: "text", text: progress }] : []),
            { type: "tool_call", call: "f", name: "finish_task", input: { summary } },
          ],
        }),
        record({ type: "tool_call_started", turn: "t", call: "f", name: "finish_task", effect: "read_only" }),
      ]
      const finish = record({ type: "tool_call_finished", turn: "t", call: "f", outcome: "completed", content: [{ type: "text", text: summary }] })
      const end = record({ type: "turn_ended", turn: "t", outcome: { status: "completed" } })
      const live = new TranscriptReducer()
      live.applyRecords([...records, finish])
      assert.equal(transcriptConversation(live.snapshot(), "You").runs[0]!.finalResponse, null)
      live.applyRecord(end)
      const run = transcriptConversation(live.snapshot(), "You", { brief: purpose === "development-story" }).runs[0]!
      assert.equal(run.finalResponse, summary)
      assert.deepEqual(run.activities?.filter(a => a.kind === "message").map(a => [a.messageKind, a.detail]), [
        ...(progress && progress !== summary ? [["intermediate", progress]] : []),
        ["final", summary],
      ])
      assert.ok(run.activities?.some(a => a.toolName === "finish_task"))
      const replay = conversation([...records, finish, end]).runs[0]!
      assert.deepEqual(replay.activities, run.activities)
      const refused = conversation([...records, { ...finish, outcome: "failed" } as SessionRecord,
        { ...end, outcome: { status: "contract_unmet" } } as SessionRecord]).runs[0]!
      assert.equal(refused.finalResponse, progress ?? null)
    }
  }
})

test("the screenshots an accepted finish attached go above the final reply", () => {
  seq = 0
  const id = "a".repeat(64)
  const images = [
    { ref: `screenshot:${id}`, caption: "Isolated component: empty state" },
    { ref: `screenshot:${id}`, caption: "the same one again" },
    { ref: "not-a-screenshot", caption: "dropped" },
  ]
  const run = conversation([
    record({ type: "session_created", config }),
    record({ type: "user_message", turn: "t", delivery: "turn", input: [{ type: "text", text: "Show it" }] }),
    record({ type: "request_started", turn: "t", request: "r", model, attempt: 1, prefix_digest: "d" }),
    record({
      type: "assistant_message", turn: "t", request: "r", stop: "tool_use", usage,
      blocks: [{ type: "tool_call", call: "f", name: "finish_task", input: { summary: "Here it is.", images } }],
    }),
    record({ type: "tool_call_started", turn: "t", call: "f", name: "finish_task", effect: "read_only" }),
    record({ type: "tool_call_finished", turn: "t", call: "f", outcome: "completed", content: [{ type: "text", text: "Here it is." }] }),
    record({ type: "turn_ended", turn: "t", outcome: { status: "completed" } }),
  ]).runs[0]!
  const final = run.activities?.find((activity) => activity.messageKind === "final")
  assert.deepEqual(final?.images, [{ caption: "Isolated component: empty state", id }])
})

test("the wrap-up card leaves out the summary only once it is the reply shown", () => {
  seq = 0
  const summary = "Renamed the helper and ran the tests."
  const records = [
    record({ type: "session_created", config }),
    record({ type: "user_message", turn: "t", delivery: "turn", input: [{ type: "text", text: "Rename it" }] }),
    record({ type: "request_started", turn: "t", request: "r", model, attempt: 1, prefix_digest: "d" }),
    record({
      type: "assistant_message", turn: "t", request: "r", stop: "tool_use", usage,
      blocks: [{ type: "tool_call", call: "f", name: "finish_task", input: { summary, verified: true } }],
    }),
    record({ type: "tool_call_started", turn: "t", call: "f", name: "finish_task", effect: "read_only" }),
  ]
  const finish = record({ type: "tool_call_finished", turn: "t", call: "f", outcome: "completed", content: [{ type: "text", text: summary }] })
  const end = record({ type: "turn_ended", turn: "t", outcome: { status: "completed" } })
  const card = (log: SessionRecord[]) => {
    const run = conversation(log).runs[0]!
    const activity = run.activities!.find((a) => a.toolName === "finish_task")!
    const view = describeToolCall(toolCallSource(activity, activity.status === "running"))
    return {
      chips: view.chips.map((chip) => chip.label),
      texts: view.bodies.flatMap((body) => (body.type === "text" ? [body.text] : [])),
      reply: run.finalResponse,
    }
  }
  // Accepted but the turn not ended yet: no reply, so the card keeps it.
  assert.deepEqual(card([...records, finish]), { chips: ["Verified"], texts: [summary], reply: null })
  // Ended (live or reloaded from the records): the reply shows it, once.
  assert.deepEqual(card([...records, finish, end]), { chips: ["Verified"], texts: [], reply: summary })
  // Refused: the summary is not the reply, the card keeps it and the refusal.
  const refused = card([
    ...records,
    { ...finish, outcome: "failed", content: [{ type: "text", text: "Run the tests first." }] } as SessionRecord,
    { ...end, outcome: { status: "contract_unmet", unmet: [] } } as SessionRecord,
  ])
  assert.ok(refused.texts.includes(summary))
  assert.notEqual(refused.reply, summary)
})

test("what only the model reads with a message never shows in the conversation", () => {
  seq = 0
  const note = "<proposal_decisions>\n- P1 added to the backlog as US-004\n</proposal_decisions>"
  const result = conversation([
    record({ type: "session_created", config }),
    record({
      type: "user_message", turn: "t", delivery: "turn",
      input: [{ type: "text", text: "Plan the next step" }, { type: "context", text: note }],
    }),
    record({ type: "request_started", turn: "t", request: "r", model, attempt: 1, prefix_digest: "d" }),
    record({ type: "assistant_message", turn: "t", request: "r", stop: "end_turn", usage, blocks: [{ type: "text", text: "Next: invoices." }] }),
    record({ type: "turn_ended", turn: "t", outcome: { status: "completed" } }),
  ])
  assert.equal(result.comments[0]!.body, "Plan the next step")
  assert.deepEqual(result.comments[0]!.fileAttachments ?? [], [])
  assert.doesNotMatch(JSON.stringify(result), /proposal_decisions/)
})

test("an image sent with a message keeps its engine blob, so the comment can show it", () => {
  seq = 0
  const sha256 = "a".repeat(64)
  const result = conversation([
    record({ type: "session_created", config }),
    record({
      type: "user_message", turn: "t", delivery: "turn",
      input: [
        { type: "text", text: "See this" },
        { type: "image", blob: { sha256, bytes: 12, media_type: "image/png" } },
      ],
    }),
    record({ type: "request_started", turn: "t", request: "r", model, attempt: 1, prefix_digest: "d" }),
    record({ type: "assistant_message", turn: "t", request: "r", stop: "end_turn", usage, blocks: [{ type: "text", text: "Seen." }] }),
    record({ type: "turn_ended", turn: "t", outcome: { status: "completed" } }),
  ])
  const [file] = result.comments[0]!.fileAttachments ?? []
  assert.equal(file?.blobId, sha256)
  assert.equal(file?.type, "image/png")
})

test("a reply the checks refused stays, unverified, with the check it names", () => {
  seq = 0
  const turnRecords = (outcome: Record<string, unknown>) => [
    record({ type: "session_created", config: { ...config, purpose: "development-story" } }),
    record({ type: "user_message", turn: "t", delivery: "turn", input: [{ type: "text", text: "Fix the GPU test" }] }),
    record({ type: "request_started", turn: "t", request: "r", model, attempt: 1, prefix_digest: "d" }),
    record({ type: "assistant_message", turn: "t", request: "r", stop: "end_turn", usage, blocks: [{ type: "text", text: "The GPU test needs a host package I cannot install." }] }),
    record({ type: "turn_ended", turn: "t", outcome }),
  ]
  const unmet = [{ kind: "result", tool: "finish_task" }]
  const refused = conversation(
    turnRecords({ status: "contract_unmet", unmet, refused: { kind: "failing_checks", tasks: ["test:gpu"] } })
  ).runs[0]!
  assert.equal(
    refused.finalResponse,
    "The GPU test needs a host package I cannot install.\n\n> **Not verified:** the last run of `test:gpu` failed."
  )
  assert.ok(!refused.activities?.some((activity) => activity.title === "Not finished"))
  assert.equal(refused.status, "completed")
  seq = 0
  const stopped = conversation(turnRecords({ status: "contract_unmet", unmet })).runs[0]!
  assert.equal(stopped.finalResponse, "The GPU test needs a host package I cannot install.")
  assert.ok(stopped.activities?.some((activity) => activity.title === "Not finished"))
})

// A turn whose agent updates its plan, once per entry: `steps` is the whole
// plan each time, `outcome` how the engine answered.
function planTurn(
  id: string,
  updates: Array<{ steps: Array<[string, string]>; outcome?: "completed" | "failed" }>
) {
  const records = [
    record({ type: "user_message", turn: id, input: [{ type: "text", text: "work" }], delivery: "turn" }),
    record({ type: "request_started", turn: id, request: `r-${id}`, model, attempt: 1, prefix_digest: "d" }),
    record({
      type: "assistant_message",
      turn: id,
      request: `r-${id}`,
      blocks: updates.map((update, index) => ({
        type: "tool_call",
        call: `plan-${id}-${index}`,
        name: "update_plan",
        input: { plan: update.steps.map(([step, status]) => ({ step, status })) },
      })),
      stop: "tool_use",
      usage,
    }),
  ]
  updates.forEach((update, index) =>
    records.push(
      record({
        type: "tool_call_finished",
        turn: id,
        call: `plan-${id}-${index}`,
        outcome: update.outcome ?? "completed",
        content: [{ type: "text", text: "Plan updated." }],
      })
    )
  )
  return records
}

test("an update of the plan shows as what it changed, and a repeat shows nothing", () => {
  const reducer = new TranscriptReducer()
  reducer.applyRecords([
    record({ type: "session_created", config }),
    ...planTurn("t1", [
      { steps: [["Add it", "in_progress"], ["Test it", "pending"]] },
      { steps: [["Add it", "in_progress"], ["Test it", "pending"]] },
      { steps: [["Add it", "completed"], ["Test it", "in_progress"]] },
    ]),
  ])
  const transcript = reducer.snapshot()
  const conversation = transcriptConversation(transcript, "You")
  const lines = conversation.runs[0]!.activities
    .filter((activity) => activity.toolName === "update_plan")
    .map((activity) => {
      const view = describeToolCall(toolCallSource(activity, false))
      return [view.verb, view.target?.text, ...view.chips.map((chip) => chip.label)]
        .filter(Boolean)
        .join(" | ")
    })
  assert.deepEqual(lines, ["Plan set | 2 steps", "Step 1 done | Add it | 1/2"])
  assert.equal(transcript.plan?.steps[0]?.status, "completed")
})

test("a turn that left its plan open says which steps", () => {
  const reducer = new TranscriptReducer()
  reducer.applyRecords([
    record({ type: "session_created", config }),
    record({ type: "user_message", turn: "t1", input: [{ type: "text", text: "work" }], delivery: "turn" }),
    record({
      type: "turn_ended",
      turn: "t1",
      outcome: {
        status: "contract_unmet",
        unmet: [{ kind: "result", tool: "finish_task" }],
        refused: { kind: "open_plan", steps: ["Wire the form", "Write tests"] },
      },
    }),
  ])
  const run = transcriptConversation(reducer.snapshot(), "You").runs[0]!
  const error = run.activities.find((activity) => activity.kind === "error")
  assert.equal(error?.title, "Not finished")
  assert.equal(
    error?.detail,
    "The agent stopped with 2 steps of its plan still open: Wire the form; Write tests."
  )
})
