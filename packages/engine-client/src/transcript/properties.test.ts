// Differential tests: random sessions with rewinds, undos, steers, failures
// and compactions, checked against the straightforward reading of the log.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { SessionRecord } from "../protocol.js"
import { Log, call, text, usage, config } from "./fixtures.js"
import type { Transcript } from "./model.js"
import { effective, linearLog } from "./oracle.js"
import { TranscriptReducer, reduceTranscript } from "./reducer.js"

/** Small deterministic generator, so a failing seed can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A session as the engine could write it, including every way a log gets cut. */
function randomSession(seed: number, steps: number): SessionRecord[] {
  const next = random(seed)
  const pick = (n: number) => Math.floor(next() * n)
  const log = new Log()
  let turnNumber = 0
  let callNumber = 0
  let lastFinished: number | undefined
  let open: string | undefined

  for (let step = 0; step < steps; step++) {
    const roll = pick(100)
    if (roll < 22 || !open) {
      turnNumber++
      open = `t${turnNumber}`
      log.user(open, `message ${turnNumber}`)
      if (pick(2)) log.checkpoint(open)
    } else if (roll < 45) {
      const request = `r${log.head}`
      const attempt = pick(4) === 0 ? (log.failed(open, request), 2) : 1
      log.request(open, request, attempt)
      const calls = Array.from({ length: pick(3) }, () => `c${++callNumber}`)
      log.reply(open, request, [text(`reply ${log.head}`), ...calls.map((c) => call(c))], calls.length ? "tool_use" : "end_turn", usage(pick(100), pick(50), pick(3) ? pick(500) : undefined))
      for (const c of calls) {
        if (pick(3) === 0) {
          log.add({ type: "approval_requested", turn: open, call: c })
          if (pick(2)) log.add({ type: "approval_resolved", turn: open, call: c, decision: "approved" })
        }
        if (pick(4) !== 0) log.started(open, c, "run", pick(2) ? "command" : "read_only")
        if (pick(4) !== 0) log.finished(open, c, pick(5) === 0 ? "failed" : "completed")
      }
    } else if (roll < 55) {
      log.user(open, `steer ${log.head}`, "steer")
    } else if (roll < 68) {
      log.ended(open, pick(3) === 0 ? "interrupted" : "completed")
      open = undefined
    } else if (roll < 74) {
      log.add({ type: "notice", level: "info", code: "n", text: `notice ${log.head}` })
    } else if (roll < 78) {
      log.add({ type: "context_compacted", through: Math.max(1, log.head - pick(5)), summary: "s", usage: usage(1, 1, 5) })
    } else if (roll < 82) {
      log.add({ type: "config_changed", config: { ...config, model: { provider: "p", model: `m${pick(3)}` } } })
    } else if (roll < 94 && log.head > 3) {
      // Rewind to any record, which cuts whatever turn is open there.
      const { finished } = log.rewind(1 + pick(log.head - 1))
      lastFinished = finished
      open = undefined
      if (pick(3) === 0) {
        log.undo(finished)
        lastFinished = undefined
      }
    } else if (lastFinished !== undefined) {
      // An undo that is no longer valid: the log has moved on.
      log.undo(lastFinished)
    }
  }
  return log.records
}

describe("the reducer against the engine's reading of the log", () => {
  for (let seed = 1; seed <= 60; seed++) {
    it(`seed ${seed}: the records in effect, and a transcript equal to folding only those`, () => {
      const records = randomSession(seed, 120)
      const reducer = new TranscriptReducer()
      records.forEach((record, index) => {
        reducer.applyRecord(record)
        const prefix = records.slice(0, index + 1)
        assert.deepEqual(
          reducer.effectiveSeqs(),
          effective(prefix).map((item) => item.seq),
          `records in effect after seq ${record.seq}`,
        )
        // Checking every record is quadratic; the whole transcript is compared every few.
        if (index % 7 === 0 || index === records.length - 1) {
          const incremental = reducer.snapshot()
          // A client that never saw the rewinds holds only the records in effect.
          const reference = reduceTranscript(linearLog(prefix))
          // `lastSeq` and `spent` legitimately differ: the reference never saw the
          // rewind bookkeeping records, nor the records a rewind removed.
          assert.deepEqual(comparable(incremental), comparable(reference), `transcript after seq ${record.seq}`)
          assert.deepEqual(incremental.usage.total, reference.usage.total)
        }
      })
    })
  }

  it("applies the same whether records arrive one by one or all at once", () => {
    const records = randomSession(99, 400)
    const oneByOne = new TranscriptReducer()
    for (const record of records) {
      oneByOne.applyRecord(record)
      oneByOne.snapshot()
    }
    assert.deepEqual(oneByOne.snapshot(), reduceTranscript(records))
  })

  it("never counts a rewound request as unspent", () => {
    const records = randomSession(5, 300)
    const spentRequests = records.filter((r) => r.type === "assistant_message" || r.type === "context_compacted").length
    assert.equal(reduceTranscript(records).usage.spent.requests, spentRequests)
  })
})

function comparable(transcript: Transcript) {
  const { lastSeq: _lastSeq, usage, ...rest } = transcript
  void _lastSeq
  return { ...rest, total: usage.total }
}
