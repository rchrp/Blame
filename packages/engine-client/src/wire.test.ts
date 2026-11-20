// The generated types must describe the JSON the engine really sends. These
// are the literals of crates/blame-engine-protocol/tests/wire.rs, typed with
// the generated declarations: a shape that drifts from the Rust one stops
// compiling here (the `@ts-expect-error` lines prove the types are not just
// `any`), and the runtime assertions pin the JSON itself.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type {
  AssistantBlock,
  ClientRequest,
  EngineNotification,
  Outcome,
  SessionRecord,
  RecordBody,
} from "./protocol.js"
import { PROTOCOL_VERSION } from "./protocol.js"

describe("generated types match the wire", () => {
  it("a record is one flat object, discriminated by `type`", () => {
    const record = {
      seq: 2,
      at_ms: 1_700_000_000_000,
      type: "user_message",
      turn: "turn-1",
      input: [{ type: "text", text: "hello" }],
      delivery: "turn",
    } satisfies SessionRecord
    const asRecord: SessionRecord = record
    if (asRecord.type === "user_message") {
      // Narrowing reaches the flattened body's fields.
      assert.equal(asRecord.turn, "turn-1")
      assert.equal(asRecord.input[0]?.type, "text")
    } else {
      assert.fail("expected a user message")
    }

    // @ts-expect-error a flattened record has no `body`
    const nested: SessionRecord = { seq: 1, at_ms: 0, body: { type: "rewind_undone", rewind: 1 } }
    void nested
    // @ts-expect-error every record carries its seq
    const noSeq: SessionRecord = { at_ms: 0, type: "rewind_undone", rewind: 1 }
    void noSeq
  })

  it("optional fields are omitted, not null", () => {
    const withNative = {
      type: "reasoning",
      text: "…",
      native: {
        wire: "anthropic-messages",
        model: { provider: "anthropic", model: "m" },
        item: { type: "thinking", thinking: "…", signature: "c2ln" },
      },
    } satisfies AssistantBlock
    const withoutNative = {
      type: "tool_call",
      call: "call-1",
      name: "read_code",
      input: { path: "a.ts" },
    } satisfies AssistantBlock
    assert.equal("native" in withoutNative, false)
    assert.equal(withNative.native.item.signature, "c2ln")

    const rewind = {
      type: "rewind_started",
      to: 3,
    } satisfies RecordBody
    assert.equal("checkpoint" in rewind, false)

    // @ts-expect-error optional means omitted: the engine never sends null
    const nullNative: AssistantBlock = { type: "text", text: "x", native: null }
    void nullNative
  })

  it("requests are `method` + `params`, notifications carry records", () => {
    const subscribe = {
      method: "session/subscribe",
      params: { session: "s", after: 12 },
    } satisfies ClientRequest
    assert.deepEqual(JSON.parse(JSON.stringify(subscribe)), {
      method: "session/subscribe",
      params: { session: "s", after: 12 },
    })
    const shutdown = { method: "shutdown", params: {} } satisfies ClientRequest
    void shutdown

    // @ts-expect-error a request has the parameters of its own method
    const wrong: ClientRequest = { method: "session/subscribe", params: { session: "s" } }
    void wrong

    const notification = {
      method: "session/record",
      params: { session: "s", record: { seq: 1, at_ms: 0, type: "rewind_undone", rewind: 9 } },
    } satisfies EngineNotification
    assert.equal(notification.method, "session/record")
  })

  it("an error response parses as an outcome", () => {
    const error = { error: { code: -32000, message: "no" } } satisfies Outcome
    assert.equal(error.error.code, -32000)
  })

  it("carries the protocol version the Rust crate declares", () => {
    assert.equal(PROTOCOL_VERSION, 1)
  })
})
