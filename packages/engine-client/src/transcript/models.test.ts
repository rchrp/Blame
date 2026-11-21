import assert from "node:assert/strict";
import { it } from "node:test";
import type { SessionRecord } from "../protocol.js";
import { turnsByModel } from "./models.js";
import { TranscriptReducer } from "./reducer.js";

const usage = { input_tokens: 1, output_tokens: 1, cost_micro_usd: 0 };
let seq = 0;
const record = (body: Record<string, unknown>) =>
  ({ seq: ++seq, at_ms: seq, ...body }) as SessionRecord;
const turn = (id: string, provider: string, model: string) => [
  record({
    type: "user_message",
    turn: id,
    delivery: "turn",
    input: [{ type: "text", text: id }],
  }),
  record({
    type: "request_started",
    turn: id,
    request: `r-${id}`,
    model: { provider, model },
    attempt: 1,
    prefix_digest: "d",
  }),
  record({
    type: "assistant_message",
    turn: id,
    request: `r-${id}`,
    stop: "end_turn",
    usage,
    blocks: [{ type: "text", text: `${id} done` }],
  }),
  record({ type: "turn_ended", turn: id, outcome: { status: "completed" } }),
];

it("counts the turns each model answered, after a model change and a rewind", () => {
  seq = 0;
  const reducer = new TranscriptReducer();
  const first = turn("t1", "anthropic", "opus");
  reducer.applyRecords([
    ...first,
    ...turn("t2", "anthropic", "opus"),
    ...turn("t3", "openai", "gpt"),
  ]);
  assert.deepEqual(turnsByModel(reducer.snapshot()), [
    { model: { provider: "anthropic", model: "opus" }, turns: 2 },
    { model: { provider: "openai", model: "gpt" }, turns: 1 },
  ]);
  // Undo everything after the first turn.
  const to = first.at(-1)!.seq;
  const started = record({ type: "rewind_started", to });
  reducer.applyRecords([
    started,
    record({
      type: "rewind_finished",
      started: started.seq,
      to,
      workspace: { status: "not_requested" },
      unreverted_commands: [],
    }),
  ]);
  assert.deepEqual(turnsByModel(reducer.snapshot()), [
    { model: { provider: "anthropic", model: "opus" }, turns: 1 },
  ]);
});
