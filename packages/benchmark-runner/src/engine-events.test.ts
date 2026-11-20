import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "@blame/engine-client";
import { acceptedFinish, benchmarkEvents, usageSummary } from "./engine-events.js";

const records = [
  { type: "request_started", turn: "t", request: "r1", model: { provider: "anthropic", model: "m" }, attempt: 1, prefix_digest: "d" },
  {
    type: "assistant_message",
    turn: "t",
    request: "r1",
    blocks: [{ type: "tool_call", call: "c1", name: "edit_code", input: { operations: [{ kind: "symbol" }] } }],
    stop: "tool_use",
    usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 40, cost_micro_usd: 1500 },
  },
  { type: "tool_call_started", turn: "t", call: "c1", name: "edit_code", effect: "workspace" },
  { type: "tool_call_finished", turn: "t", call: "c1", outcome: "completed", content: [{ type: "text", text: "Edited." }] },
  {
    type: "assistant_message",
    turn: "t",
    request: "r2",
    blocks: [{ type: "tool_call", call: "c2", name: "finish_task", input: { summary: "Done." } }],
    stop: "tool_use",
    usage: { input_tokens: 120, output_tokens: 5, cost_micro_usd: 500 },
  },
  { type: "tool_call_started", turn: "t", call: "c2", name: "finish_task", effect: "read_only" },
  { type: "tool_call_finished", turn: "t", call: "c2", outcome: "completed", content: [{ type: "text", text: "Done." }] },
  { type: "turn_ended", turn: "t", outcome: { status: "completed" } },
].map((record, index) => ({ seq: index + 1, at_ms: 1000 + index, ...record })) as SessionRecord[];

const trace = [
  { at: 1, toolCallId: "c1", tool: "edit_code", raw: { status: "ok", data: { changed: true, sourceRevisionId: "src_1" } } },
  {
    at: 2,
    toolCallId: "c2",
    tool: "finish_task",
    raw: {
      status: "ok",
      data: { notification: { completion: { delivery: "satisfied" }, verified: true, summary: "Done." } },
    },
  },
];

test("tool events carry their input and the harness's raw result", () => {
  const events = benchmarkEvents("s", records, trace);
  const finished = events.find(
    ({ event }) => event.type === "tool" && event.payload.phase === "finished",
  )!;
  assert.equal(finished.at, 1003);
  assert.deepEqual(finished.event.payload.toolCall, {
    id: "c1",
    name: "edit_code",
    input: { operations: [{ kind: "symbol" }] },
  });
  assert.deepEqual(finished.event.payload.output, trace[0]!.raw);
});

test("usage reports keep running totals and the run ends with the finish", () => {
  const events = benchmarkEvents("s", records, trace).map(({ event }) => event);
  const usage = events.filter((event) => event.type === "usage");
  assert.deepEqual(usage.at(-1)!.payload.usage, {
    type: "usage",
    inputTokens: 120,
    outputTokens: 5,
    cost: 0.0005,
    totalInputTokens: 220,
    totalOutputTokens: 15,
    totalCacheReadTokens: 40,
    totalCacheWriteTokens: 0,
    totalCost: 0.002,
  });
  const done = events.at(-1)!;
  assert.equal(done.type, "done");
  assert.deepEqual(done.payload.completion, { delivery: "satisfied" });
  assert.equal(done.payload.verified, true);
  assert.equal(usageSummary(records).aggregateUsage.totalInputTokens, 220);
  assert.equal(acceptedFinish(trace).summary, "Done.");
});

test("a run the agent did not finish ends with an error", () => {
  const unfinished = records.map((record) =>
    record.type === "turn_ended"
      ? { ...record, outcome: { status: "contract_unmet", unmet: [{ kind: "result", tool: "finish_task" }] } }
      : record,
  ) as SessionRecord[];
  const last = benchmarkEvents("s", unfinished, []).at(-1)!.event;
  assert.equal(last.type, "error");
  assert.match(String(last.payload.message), /finish_task/);
});
