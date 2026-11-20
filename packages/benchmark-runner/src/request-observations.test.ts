import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "@blame/engine-client";
import { BenchmarkMetricsCollector } from "./benchmark-metrics.js";
import { benchmarkEvents } from "./engine-events.js";

// The engine records every request it sends and every complete reply, so
// the observations are counts, not guesses from agent events.
function observations(records: Array<Record<string, unknown>>) {
  const collector = new BenchmarkMetricsCollector();
  const events = benchmarkEvents(
    "s",
    records.map((record, index) => ({ seq: index + 1, at_ms: index, ...record })) as SessionRecord[],
    [],
  );
  for (const { at, event } of events) collector.record(event, at);
  return JSON.parse(
    JSON.stringify(collector.summary(new Date(0), new Date(1000)).context),
  ) as {
    modelRequests: number;
    averageInputTokens: number | null;
    requestObservations: {
      coverage: string;
      iterationStartEvents: number;
      transportAttempts: number;
      completedResponses: number;
    };
  };
}

const started = (attempt: number) => ({
  type: "request_started",
  turn: "t",
  request: `r${attempt}`,
  model: { provider: "anthropic", model: "m" },
  attempt,
  prefix_digest: "d",
});
const reply = (inputTokens?: number) => ({
  type: "assistant_message",
  turn: "t",
  request: "r",
  blocks: [],
  stop: "end_turn",
  usage: inputTokens === undefined ? { output_tokens: 3 } : { input_tokens: inputTokens, output_tokens: 3 },
});

test("a retried request is two attempts, one iteration and one reply", () => {
  const context = observations([
    started(1),
    { type: "request_failed", turn: "t", request: "r1", error: { kind: "overloaded", message: "busy" } },
    started(2),
    reply(40),
  ]);
  assert.equal(context.modelRequests, 2);
  assert.equal(context.requestObservations.coverage, "engine_records");
  assert.equal(context.requestObservations.iterationStartEvents, 1);
  assert.equal(context.requestObservations.transportAttempts, 2);
  assert.equal(context.requestObservations.completedResponses, 1);
  assert.equal(context.averageInputTokens, 40);
});

test("a request still waiting has no reply and no input sample", () => {
  const context = observations([started(1)]);
  assert.equal(context.modelRequests, 1);
  assert.equal(context.requestObservations.completedResponses, 0);
  assert.equal(context.averageInputTokens, null);
});

test("a compaction's usage is not a reply to the agent's request", () => {
  const context = observations([
    started(1),
    reply(10),
    { type: "context_compacted", through: 2, summary: "s", usage: { input_tokens: 500 } },
  ]);
  assert.equal(context.requestObservations.completedResponses, 1);
});

test("a reply without input tokens is a report, not an input sample", () => {
  const context = observations([started(1), reply()]);
  assert.equal(context.averageInputTokens, null);
  assert.equal(context.requestObservations.completedResponses, 1);
});
