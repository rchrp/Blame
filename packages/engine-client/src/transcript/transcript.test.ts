import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Delta } from "../protocol.js"
import { Log, call, reasoning, text, usage } from "./fixtures.js"
import { linearLog } from "./oracle.js"
import { TranscriptReducer, reduceTranscript } from "./reducer.js"
import type { ToolCallItem, TranscriptItem, UserItem } from "./model.js"

const kinds = (items: readonly TranscriptItem[]) => items.map((item) => item.kind)
const tool = (items: readonly TranscriptItem[], id: string) =>
  items.find((item): item is ToolCallItem => item.kind === "tool_call" && item.call === id)!

describe("a plain turn", () => {
  it("shows the user message, the reply in block order, and where the turn stands", () => {
    const log = new Log()
    log.user("t1", "fix the build")
    log.checkpoint("t1")
    log.request("t1", "r1")
    log.reply("t1", "r1", [reasoning("let me look"), text("Done."), call("c1")], "tool_use", usage(100, 20, 1_500))
    log.started("t1", "c1")
    log.finished("t1", "c1", "completed", "file contents")
    log.request("t1", "r2")
    log.reply("t1", "r2", [text("All good.")], "end_turn", usage(150, 10, 900))
    log.ended("t1")

    const transcript = reduceTranscript(log.records)
    assert.deepEqual(kinds(transcript.items), ["user", "reasoning", "text", "tool_call", "text", "turn_ended"])
    assert.equal(transcript.lastSeq, log.head)
    assert.equal(transcript.config?.model.model, "sonnet")

    const [turn] = transcript.turns
    assert.equal(turn?.status, "completed")
    assert.equal(turn?.requests, 2)
    assert.equal(turn?.usage.costMicroUsd, 2_400)
    assert.equal(turn?.usage.inputTokens, 250)
    assert.equal(transcript.runningTurn, undefined)

    const first = transcript.items[1]
    assert.ok(first?.kind === "reasoning" && first.message.blockCount === 3)
    assert.equal(first.message.model?.model, "sonnet")
    assert.deepEqual(transcript.usage.total, transcript.usage.spent)
    assert.equal(transcript.usage.total.requests, 2)
  })

  it("marks which user messages can be rolled back to, and whether the files can follow", () => {
    const log = new Log()
    log.turn("t1", "first", "one")
    log.user("t2", "second") // no checkpoint: checkpoints were off, or the engine had none
    log.request("t2", "r2")
    log.reply("t2", "r2", [text("two")])
    log.ended("t2")
    const { items, checkpoints } = reduceTranscript(log.records)
    const users = items.filter((item) => item.kind === "user")
    assert.deepEqual(
      users.map((user) => user.kind === "user" && user.rewind),
      [
        { to: 1, workspace: true },
        { to: 6, workspace: false },
      ],
    )
    assert.deepEqual(checkpoints, [{ turn: "t1", checkpoint: "cp-t1", userSeq: 2, to: 1 }])
  })

  it("counts unpriced replies instead of pretending they were free", () => {
    const log = new Log()
    log.user("t1", "hi")
    log.request("t1", "r1")
    log.reply("t1", "r1", [text("a")], "end_turn", usage(1, 1))
    const { usage: totals } = reduceTranscript(log.records)
    assert.equal(totals.total.costMicroUsd, 0)
    assert.equal(totals.total.unpricedRequests, 1)
  })
})

describe("tool calls", () => {
  function parallel(): Log {
    const log = new Log()
    log.user("t1", "check three files")
    log.request("t1", "r1")
    log.reply("t1", "r1", [call("a"), call("b", "run_command"), call("c")], "tool_use")
    return log
  }

  it("follows parallel calls through approval, start and out-of-order results", () => {
    const log = parallel()
    log.add({ type: "approval_requested", turn: "t1", call: "b" })
    log.started("t1", "a")
    log.started("t1", "c")
    let { items, pendingApprovals } = reduceTranscript(log.records)
    assert.deepEqual(["a", "b", "c"].map((id) => tool(items, id).state), ["running", "awaiting_approval", "running"])
    assert.deepEqual(pendingApprovals.map((p) => p.call), ["b"])

    log.finished("t1", "c", "completed", "C")
    log.add({ type: "approval_resolved", turn: "t1", call: "b", decision: "approved" })
    log.started("t1", "b", "run_command", "command")
    log.finished("t1", "a", "failed", "A broke")
    log.finished("t1", "b", "completed", "B")
    ;({ items, pendingApprovals } = reduceTranscript(log.records))
    assert.deepEqual(["a", "b", "c"].map((id) => tool(items, id).state), ["failed", "completed", "completed"])
    assert.equal(pendingApprovals.length, 0)
    assert.equal(tool(items, "b").approval, "approved")
    assert.equal(tool(items, "b").effect, "command")
    assert.deepEqual(tool(items, "a").result, [{ type: "text", text: "A broke" }])
    assert.equal(tool(items, "c").input && typeof tool(items, "c").input, "object")
  })

  it("keeps a call's single result: the first one stored", () => {
    const log = parallel()
    log.started("t1", "a")
    log.finished("t1", "a", "completed", "first")
    log.finished("t1", "a", "failed", "second")
    const a = tool(reduceTranscript(log.records).items, "a")
    assert.equal(a.state, "completed")
    assert.deepEqual(a.result, [{ type: "text", text: "first" }])
  })

  it("shows a denied call as denied and counts a re-run after recovery", () => {
    const log = parallel()
    log.add({ type: "approval_requested", turn: "t1", call: "b" })
    log.add({ type: "approval_resolved", turn: "t1", call: "b", decision: "denied" })
    log.finished("t1", "b", "denied", "refused")
    log.started("t1", "a")
    log.started("t1", "a") // the engine restarted and ran it again
    const { items } = reduceTranscript(log.records)
    assert.equal(tool(items, "b").state, "denied")
    assert.equal(tool(items, "b").approval, "denied")
    assert.equal(tool(items, "a").starts, 2)
  })

  it("tolerates records of a call whose assistant message is not in the transcript", () => {
    const log = new Log(false)
    log.started("t1", "ghost", "run_command", "command")
    log.finished("t1", "ghost")
    const { items } = reduceTranscript(log.records)
    assert.equal(tool(items, "ghost").name, "run_command")
    assert.equal(tool(items, "ghost").state, "completed")
  })
})

describe("failures, steers and interruptions", () => {
  it("shows a failed request once, marked as retried, under the same request id", () => {
    const log = new Log()
    log.user("t1", "go")
    log.request("t1", "r1")
    log.failed("t1", "r1")
    let transcript = reduceTranscript(log.records)
    const failed = transcript.items.find((item) => item.kind === "request_failed")
    assert.ok(failed?.kind === "request_failed" && !failed.retried)

    log.request("t1", "r1", 2)
    log.reply("t1", "r1", [text("ok")])
    log.ended("t1")
    transcript = reduceTranscript(log.records)
    const retried = transcript.items.find((item) => item.kind === "request_failed")
    assert.ok(retried?.kind === "request_failed" && retried.retried && retried.attempt === 1)
    assert.equal(transcript.turns[0]?.requests, 1, "a retry is not another request")
    const answer = transcript.items.find((item) => item.kind === "text")
    assert.ok(answer?.kind === "text" && answer.message.attempt === 2)
  })

  it("shows a steer inline and hands it to the model at the next request", () => {
    const log = new Log()
    log.user("t1", "refactor")
    log.request("t1", "r1")
    log.user("t1", "also keep the tests", "steer")
    let items = reduceTranscript(log.records).items
    const delivered = () =>
      items.find((item) => item.kind === "user" && item.delivery === "steer")?.kind === "user" &&
      (items.find((item) => item.kind === "user" && item.delivery === "steer") as UserItem).delivered
    assert.equal(delivered(), false)

    log.reply("t1", "r1", [call("c1")], "tool_use")
    log.started("t1", "c1")
    log.finished("t1", "c1")
    log.request("t1", "r2")
    items = reduceTranscript(log.records).items
    assert.equal(delivered(), true)
    assert.deepEqual(kinds(items).slice(0, 3), ["user", "user", "tool_call"], "ordered as stored")
  })

  it("ends calls the interrupted turn never finished, and keeps what the engine recorded for the rest", () => {
    const log = new Log()
    log.user("t1", "long job")
    log.request("t1", "r1")
    log.reply("t1", "r1", [call("slow"), call("quick")], "tool_use")
    log.started("t1", "slow", "run_command", "command")
    log.started("t1", "quick")
    log.finished("t1", "quick")
    log.ended("t1", "interrupted")
    const transcript = reduceTranscript(log.records)
    const slow = tool(transcript.items, "slow")
    assert.equal(slow.state, "cancelled")
    assert.ok(slow.endedWithoutResult && slow.result === undefined)
    assert.equal(tool(transcript.items, "quick").state, "completed")
    assert.equal(transcript.turns[0]?.status, "interrupted")
    assert.equal(transcript.runningTurn, undefined)
  })

  it("shows a call a crash interrupted as such once recovery has recorded it", () => {
    const log = new Log()
    log.user("t1", "go")
    log.request("t1", "r1")
    log.reply("t1", "r1", [call("c1")], "tool_use")
    log.started("t1", "c1", "run_command", "command")
    // The engine restarted: recovery records what it knows, then ends the turn.
    log.finished("t1", "c1", "interrupted", "the engine stopped while this ran")
    log.ended("t1", "interrupted")
    const { items } = reduceTranscript(log.records)
    assert.equal(tool(items, "c1").state, "interrupted")
    assert.equal(tool(items, "c1").endedWithoutResult, false)
  })

  it("queues a message sent during a turn and starts it when the first ends", () => {
    const log = new Log()
    log.user("t1", "first")
    log.request("t1", "r1")
    log.user("t2", "second")
    let transcript = reduceTranscript(log.records)
    assert.deepEqual(transcript.turns.map((t) => t.status), ["running", "queued"])
    assert.equal(transcript.runningTurn, "t1")

    log.reply("t1", "r1", [text("one")])
    log.ended("t1")
    transcript = reduceTranscript(log.records)
    assert.deepEqual(transcript.turns.map((t) => t.status), ["completed", "running"])
    assert.equal(transcript.runningTurn, "t2")
  })

  it("records a turn that failed or hit a limit", () => {
    const log = new Log()
    log.user("t1", "go")
    log.add({ type: "turn_ended", turn: "t1", outcome: { status: "limit_reached", limit: "max_cost_micro_usd" } })
    log.user("t2", "again")
    log.add({ type: "turn_ended", turn: "t2", outcome: { status: "failed", error: { kind: "billing", message: "no credit" } } })
    const { turns, items } = reduceTranscript(log.records)
    assert.deepEqual(turns.map((t) => t.status), ["limit_reached", "failed"])
    const last = items[items.length - 1]
    assert.ok(last?.kind === "turn_ended" && last.outcome.status === "failed")
  })
})

describe("compaction, notices and configuration", () => {
  it("keeps the whole transcript, marks what is summarised, and counts the compaction's cost", () => {
    const log = new Log()
    log.turn("t1", "one", "1")
    log.turn("t2", "two", "2")
    const compacted = log.add({ type: "context_compacted", through: 6, summary: "they said one", usage: usage(500, 50, 700) })
    log.add({ type: "context_edited", edits: [{ target: 4, block: 0, replacement: "[stale]" }] })
    log.turn("t3", "three", "3")
    const transcript = reduceTranscript(log.records)
    assert.equal(transcript.compactedThrough, 6)
    assert.equal(transcript.items.filter((item) => item.kind === "text").length, 3, "edits are for the model, not the user")
    const compaction = transcript.items.find((item) => item.kind === "compaction")
    assert.ok(compaction?.kind === "compaction" && compaction.seq === compacted && compaction.summary === "they said one")
    assert.equal(transcript.usage.total.costMicroUsd, 3 * 100 + 700)
    assert.equal(transcript.turns.reduce((sum, t) => sum + t.usage.costMicroUsd, 0), 300)
  })

  it("shows notices and model switches", () => {
    const log = new Log()
    log.add({ type: "notice", level: "warning", code: "rate_limited", text: "slow down" })
    log.add({ type: "config_changed", config: { ...reduceTranscript(log.records).config!, system_prompt: "other" } })
    log.add({
      type: "config_changed",
      config: { ...reduceTranscript(log.records).config!, model: { provider: "openai", model: "gpt" } },
    })
    const transcript = reduceTranscript(log.records)
    assert.deepEqual(kinds(transcript.items), ["notice", "model_changed"])
    assert.equal(transcript.config?.model.model, "gpt")
    const changed = transcript.items[1]
    assert.ok(changed?.kind === "model_changed" && changed.previous?.model === "sonnet")
  })
})

describe("rewinds", () => {
  function twoTurns(): Log {
    const log = new Log()
    log.turn("t1", "first", "one") // 2..6
    log.turn("t2", "second", "two") // 7..11
    return log
  }

  it("no longer shows what a rewind removed, and leaves a cut where it happened", () => {
    const log = twoTurns()
    const { started, finished } = log.rewind(6)
    assert.ok(started < finished)
    const transcript = reduceTranscript(log.records)
    assert.deepEqual(kinds(transcript.items), ["user", "text", "turn_ended", "rewind"])
    assert.deepEqual(transcript.turns.map((t) => t.turn), ["t1"])
    assert.equal(transcript.checkpoints.length, 1)
    assert.equal(transcript.undoableRewind, finished)
    const cut = transcript.items.at(-1)
    assert.ok(cut?.kind === "rewind" && cut.to === 6)
    assert.equal(transcript.usage.total.requests, 1)
    assert.equal(transcript.usage.spent.requests, 2, "what the rewound turn cost was still spent")
  })

  it("an undo right after brings back exactly what was removed", () => {
    const log = twoTurns()
    const before = reduceTranscript(log.records)
    const { finished } = log.rewind(6)
    log.undo(finished)
    const after = reduceTranscript(log.records)
    assert.deepEqual(after.items, before.items)
    assert.deepEqual(after.turns, before.turns)
    assert.deepEqual(after.checkpoints, before.checkpoints)
    assert.deepEqual(after.usage.total, before.usage.total)
    assert.equal(after.undoableRewind, undefined)
  })

  it("an undo that is not the next record does nothing", () => {
    const log = twoTurns()
    const { finished } = log.rewind(6)
    log.turn("t3", "third", "three")
    log.undo(finished)
    const transcript = reduceTranscript(log.records)
    assert.deepEqual(transcript.turns.map((t) => t.turn), ["t1", "t3"])
    assert.equal(transcript.items.filter((item) => item.kind === "rewind").length, 1)
  })

  it("rewinds nest, and the first turn can be rewound", () => {
    const log = twoTurns()
    log.rewind(1)
    log.turn("t3", "again", "three")
    const second = log.rewind(log.head - 2)
    const transcript = reduceTranscript(log.records)
    assert.deepEqual(transcript.turns.map((t) => `${t.turn}:${t.status}`), ["t3:rewound"])
    assert.equal(transcript.undoableRewind, second.finished)
  })

  it("ends a turn that was open where the log was cut, and its unfinished calls", () => {
    const log = new Log()
    log.user("t1", "go")
    log.request("t1", "r1")
    const replied = log.reply("t1", "r1", [call("c1")], "tool_use")
    log.started("t1", "c1", "run_command", "command")
    log.finished("t1", "c1")
    log.ended("t1")
    log.rewind(replied)
    const transcript = reduceTranscript(log.records)
    assert.equal(transcript.turns[0]?.status, "rewound")
    assert.equal(transcript.runningTurn, undefined)
    const c1 = tool(transcript.items, "c1")
    assert.equal(c1.state, "cancelled")
    assert.ok(c1.endedWithoutResult)

    log.user("t2", "next")
    assert.equal(reduceTranscript(log.records).turns[1]?.status, "running", "the cut turn does not block the next one")
  })

  it("takes back approvals, configuration and compaction along with the records", () => {
    const log = new Log()
    log.turn("t1", "one", "1")
    const keep = log.head
    log.user("t2", "two")
    log.request("t2", "r2")
    log.reply("t2", "r2", [call("c")], "tool_use")
    log.add({ type: "approval_requested", turn: "t2", call: "c" })
    log.add({ type: "config_changed", config: { ...reduceTranscript(log.records).config!, model: { provider: "x", model: "y" } } })
    log.add({ type: "context_compacted", through: 4, summary: "s", usage: usage(1, 1, 10) })
    log.rewind(keep)
    const transcript = reduceTranscript(log.records)
    assert.equal(transcript.pendingApprovals.length, 0)
    assert.equal(transcript.config?.model.model, "sonnet")
    assert.equal(transcript.compactedThrough, undefined)
  })

  it("reads the log the way the engine does: the same records are in effect", () => {
    const log = twoTurns()
    const first = log.rewind(6)
    log.undo(first.finished)
    log.rewind(2)
    log.user("t3", "third")
    const reducer = new TranscriptReducer()
    log.records.forEach((record, index) => {
      reducer.applyRecord(record)
      const expected = linearLogSeqs(log.records.slice(0, index + 1))
      assert.deepEqual(reducer.effectiveSeqs(), expected, `after record ${record.seq}`)
    })
  })
})

function linearLogSeqs(records: Parameters<typeof linearLog>[0]): number[] {
  return linearLog(records).map((record) => record.seq)
}

describe("live deltas", () => {
  const request = "r1"
  const streaming: Delta[] = [
    { type: "block_started", request, index: 0, kind: "reasoning" },
    { type: "reasoning", request, index: 0, text: "hmm " },
    { type: "reasoning", request, index: 0, text: "ok" },
    { type: "block_started", request, index: 1, kind: "text" },
    { type: "text", request, index: 1, text: "Hel" },
    { type: "text", request, index: 1, text: "lo" },
    { type: "block_started", request, index: 2, kind: "tool_call", call: "c1", tool: "read_code" },
    { type: "tool_input", request, index: 2, json: '{"path":' },
    { type: "tool_input", request, index: 2, json: '"a.ts"}' },
  ]

  it("assembles the reply being streamed, block by block", () => {
    const log = new Log()
    log.user("t1", "hi")
    log.request("t1", request)
    const { live } = reduceTranscript(log.records, streaming)
    assert.deepEqual(
      live?.blocks.map((b) => [b.kind, b.text, b.inputJson, b.call, b.tool]),
      [
        ["reasoning", "hmm ok", "", undefined, undefined],
        ["text", "Hello", "", undefined, undefined],
        ["tool_call", "", '{"path":"a.ts"}', "c1", "read_code"],
      ],
    )
  })

  it("replaces the stream by the stored reply, and ignores deltas that arrive late", () => {
    const log = new Log()
    log.user("t1", "hi")
    log.request("t1", request)
    const reducer = new TranscriptReducer()
    reducer.applyRecords(log.records)
    for (const delta of streaming) reducer.applyDelta(delta)
    assert.ok(reducer.snapshot().live)
    reducer.applyRecord({ seq: 4, at_ms: 1, type: "assistant_message", turn: "t1", request, blocks: [text("Hello")], stop: "end_turn", usage: {} })
    assert.equal(reducer.snapshot().live, undefined)
    reducer.applyDelta({ type: "text", request, index: 1, text: "stale" })
    assert.equal(reducer.snapshot().live, undefined)
    // A retry of the same request streams again.
    reducer.applyRecord({ seq: 5, at_ms: 2, type: "request_started", turn: "t1", request, model: { provider: "a", model: "b" }, attempt: 2, prefix_digest: "" })
    reducer.applyDelta({ type: "text", request, index: 0, text: "again" })
    assert.equal(reducer.snapshot().live?.blocks[0]?.text, "again")
  })

  it("follows a running tool's output and the session's activity", () => {
    const log = new Log()
    log.user("t1", "go")
    log.request("t1", "r1")
    log.reply("t1", "r1", [call("c1")], "tool_use")
    log.started("t1", "c1", "run_command", "command")
    const reducer = new TranscriptReducer()
    reducer.applyRecords(log.records)
    reducer.applyDelta({ type: "activity", activity: { state: "running_tools" } })
    reducer.applyDelta({ type: "tool_progress", call: "c1", text: "building…\n" })
    reducer.applyDelta({ type: "tool_progress", call: "c1", text: "done\n" })
    assert.equal(reducer.snapshot().activity.state, "running_tools")
    assert.equal(reducer.snapshot().toolProgress.get("c1"), "building…\ndone\n")
    reducer.applyRecord({ seq: 6, at_ms: 9, type: "tool_call_finished", turn: "t1", call: "c1", outcome: "completed", content: [] })
    assert.equal(reducer.snapshot().toolProgress.has("c1"), false)
  })

  it("starts the stream over after a reconnect", () => {
    const reducer = new TranscriptReducer()
    for (const delta of streaming) reducer.applyDelta(delta)
    reducer.resetLive()
    assert.equal(reducer.snapshot().live, undefined)
    for (const delta of streaming.slice(3, 6)) reducer.applyDelta(delta)
    assert.equal(reducer.snapshot().live?.blocks[0]?.text, "Hello")
  })
})

describe("applying records one at a time", () => {
  it("ignores a record it has already seen, so overlapping pages are harmless", () => {
    const log = new Log()
    log.turn("t1", "a", "b")
    const reducer = new TranscriptReducer()
    reducer.applyRecords(log.records)
    const once = reducer.snapshot()
    reducer.applyRecords(log.records)
    assert.equal(reducer.applyRecord(log.records[2]!), false)
    assert.equal(reducer.snapshot(), once, "nothing changed, so the very same snapshot")
  })

  it("keeps the identity of every item a new record did not touch", () => {
    const log = new Log()
    log.turn("t1", "a", "b")
    log.user("t2", "c")
    log.request("t2", "r2")
    log.reply("t2", "r2", [call("c1")], "tool_use")
    const reducer = new TranscriptReducer()
    reducer.applyRecords(log.records)
    const before = reducer.snapshot()
    reducer.applyRecord({ seq: log.head + 1, at_ms: 1, type: "tool_call_started", turn: "t2", call: "c1", name: "read_code", effect: "read_only" })
    const after = reducer.snapshot()
    const changed = after.items.filter((item, i) => before.items[i] !== item)
    assert.equal(changed.length, 1)
    assert.equal(changed[0]?.kind, "tool_call")
    assert.equal(after.turns[0], before.turns[0])
    assert.notEqual(after.items, before.items)
  })

  it("does not copy the stored transcript for a delta", () => {
    const log = new Log()
    log.turn("t1", "a", "b")
    const reducer = new TranscriptReducer()
    reducer.applyRecords(log.records)
    const before = reducer.snapshot()
    reducer.applyDelta({ type: "text", request: "r9", index: 0, text: "x" })
    const after = reducer.snapshot()
    assert.notEqual(after, before)
    assert.equal(after.items, before.items)
    assert.equal(after.turns, before.turns)
  })

  it("stays fast on a long session: thousands of records, a snapshot per batch, a rewind near the end", () => {
    const log = new Log()
    for (let i = 0; i < 4_000; i++) log.turn(`t${i}`, `message ${i}`, `answer ${i}`)
    const reducer = new TranscriptReducer()
    const started = performance.now()
    log.records.forEach((record, index) => {
      reducer.applyRecord(record)
      if (index % 200 === 0) reducer.snapshot()
    })
    const rewound = log.rewind(log.head - 10)
    for (const record of log.records.slice(-2)) reducer.applyRecord(record)
    log.undo(rewound.finished)
    reducer.applyRecord(log.records.at(-1)!)
    const transcript = reducer.snapshot()
    assert.equal(transcript.items.length, 4_000 * 3 + 0)
    assert.ok(performance.now() - started < 5_000, "a quadratic reducer would take minutes here")
  })
})
