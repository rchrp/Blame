import assert from "node:assert/strict";
import test from "node:test";
import type { BenchmarkEvent } from "./engine-events.js";
import { BenchmarkMetricsCollector } from "./benchmark-metrics.js";

test("attributes model context and tool payload exposure", () => {
  const collector = new BenchmarkMetricsCollector();
  collector.record(usageEvent(1_000), 1_000);
  collector.record(toolEvent("started"), 2_000);
  collector.record(toolEvent("finished"), 3_000);
  collector.record(usageEvent(2_000), 4_000);
  collector.record(usageEvent(3_000), 5_000);
  const metrics = collector.summary(new Date(0), new Date(40_000));
  assert.equal(metrics.context.modelRequests, 0, "no request notice was recorded");
  assert.equal(metrics.context.requestObservations.inputTokenReportEvents, 3);
  assert.equal(metrics.context.requestObservations.usageReportEvents, 3);
  assert.equal(metrics.context.averageInputTokens, 2_000);
  assert.equal(metrics.context.maximumInputTokens, 3_000);
  assert.equal(metrics.tools.calls, 1);
  assert.equal(metrics.toolsByName.edit_code?.calls, 1);
  assert.equal(metrics.editing.successful, 1);
  assert.equal(metrics.editing.symbolOperations, 1);
  assert.equal(metrics.context.toolPayloadReplayExposureBytes, 264);
  assert.equal(metrics.toolFreeGaps.countOverThirtySeconds, 1);
});

test("separates navigation deduplication and blocked edits", () => {
  const collector = new BenchmarkMetricsCollector();
  collector.record(
    finishedTool("read_code", {
      status: "ok",
      data: { status: "already_in_context" },
    }),
    1_000,
  );
  collector.record(
    finishedTool("search_code", { status: "ok", data: {} }),
    2_000,
  );
  collector.record(finishedTool("edit_code", { status: "blocked" }), 3_000);
  const metrics = collector.summary(new Date(0), new Date(4_000));
  assert.equal(metrics.navigation.readCalls, 1);
  assert.equal(metrics.navigation.searchCalls, 1);
  assert.equal(metrics.navigation.deduplicatedReads, 1);
  assert.equal(metrics.editing.blocked, 1);
  assert.equal(metrics.tools.blockedCalls, 1);
});

function usageEvent(inputTokens: number): BenchmarkEvent {
  return { type: "usage", sessionId: "s", payload: { usage: { inputTokens } } };
}

function toolEvent(phase: "finished" | "started"): BenchmarkEvent {
  const input = {
    operations: [
      {
        action: "replace_body",
        content: "return 2",
        kind: "symbol",
        target: "s1",
      },
    ],
  };
  return {
    type: "tool",
    sessionId: "s",
    payload: {
      phase,
      toolCall: { id: "edit-1", input, name: "edit_code" },
      ...(phase === "finished"
        ? { output: { status: "ok", data: { changed: true } } }
        : {}),
    },
  };
}

function finishedTool(
  tool: string,
  output: unknown,
  input: unknown = {},
): BenchmarkEvent {
  return {
    type: "tool",
    sessionId: "s",
    payload: {
      output,
      phase: "finished",
      toolCall: { id: tool, input, name: tool },
    },
  };
}
