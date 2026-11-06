import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@blame/agent-runtime";
import { encodeToolResult } from "@blame/agent-runtime/tool-result-envelope";
import { BenchmarkMetricsCollector } from "./benchmark-metrics.js";

test("attributes model context and tool payload exposure", () => {
  const collector = new BenchmarkMetricsCollector();
  collector.record(usageEvent(1_000), 1_000);
  collector.record(toolEvent("started"), 2_000);
  collector.record(toolEvent("finished"), 3_000);
  collector.record(usageEvent(2_000), 4_000);
  collector.record(usageEvent(3_000), 5_000);
  const metrics = collector.summary(new Date(0), new Date(40_000));
  assert.equal(metrics.context.modelRequests, null);
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

test("reads harness results from their multipart envelope", () => {
  const collector = new BenchmarkMetricsCollector();
  const output = encodeToolResult({
    status: "ok",
    data: { changed: true, diagnostic: "formatted\nfile" },
  });
  assert.ok(Array.isArray(output));
  collector.record(finishedTool("edit_code", output), 1_000);
  const metrics = collector.summary(new Date(0), new Date(2_000));
  assert.equal(metrics.editing.successful, 1);
  assert.equal(metrics.tools.outputBytes, JSON.stringify(output).length);
});

test("measures Cline batched reads, searches, and patches", () => {
  const collector = new BenchmarkMetricsCollector();
  collector.record(
    finishedTool(
      "read_files",
      [{ query: "a.ts", result: "source", success: true }],
      { files: [{ path: "a.ts" }, { path: "b.ts" }] },
    ),
    1_000,
  );
  collector.record(
    finishedTool(
      "search_codebase",
      [{ query: "name", result: "match", success: true }],
      { queries: ["name", "reference", "test"] },
    ),
    2_000,
  );
  collector.record(
    finishedTool("apply_patch", {
      query: "apply_patch",
      result: "applied",
      success: true,
    }),
    3_000,
  );
  const metrics = collector.summary(new Date(0), new Date(4_000));
  assert.equal(metrics.navigation.readCalls, 2);
  assert.equal(metrics.navigation.searchCalls, 3);
  assert.equal(metrics.editing.attempts, 1);
  assert.equal(metrics.editing.patchOperations, 1);
  assert.equal(metrics.editing.successful, 1);
  assert.equal(metrics.editing.firstAttemptMs, 3_000);
  assert.equal(metrics.editing.firstSuccessMs, 3_000);
});

test("records rejected Cline patches as failed editing attempts", () => {
  const collector = new BenchmarkMetricsCollector();
  collector.record(
    finishedTool("apply_patch", {
      query: "apply_patch",
      result: "context not found",
      success: false,
    }),
    1_000,
  );
  const metrics = collector.summary(new Date(0), new Date(2_000));
  assert.equal(metrics.editing.attempts, 1);
  assert.equal(metrics.editing.blocked, 1);
  assert.equal(metrics.editing.successful, 0);
  assert.equal(metrics.tools.failedCalls, 1);
});

test("aggregates provider context composition notices", () => {
  const collector = new BenchmarkMetricsCollector();
  collector.record(compositionEvent(1, 900, 100, 20));
  collector.record(compositionEvent(2, 1_100, 150, 30));
  const composition = collector.summary(new Date(0), new Date(1)).context
    .composition;
  assert.equal(composition.requests, 2);
  assert.equal(composition.composedBytes, 2_000);
  assert.equal(composition.maximumComposedBytes, 1_100);
  assert.equal(composition.latestProjectedBytesSaved, 150);
  assert.equal(composition.duplicateBytes, 50);
  assert.equal(composition.messageBytes, 1_100);
  assert.equal(composition.systemPromptBytes, 600);
  assert.equal(composition.toolDefinitionBytes, 300);
  assert.equal(composition.latestMessageBytes, 600);
  assert.equal(composition.latestSystemPromptBytes, 300);
  assert.equal(composition.latestToolDefinitionBytes, 150);
  assert.equal(composition.categoryBytes["tool_input.edit_code"], 500);
  assert.equal(composition.staleReadReplacements, 2);
  assert.equal(composition.successfulEditReplacements, 4);
  assert.equal(composition.validatedEditReplacements, 6);
});

test("records selective project memory without its content", () => {
  const collector = new BenchmarkMetricsCollector();
  collector.record({
    type: "notice",
    payload: {
      kind: "project_memory_selected",
      metrics: {
        bytes: 620,
        candidates: 12,
        relevant: 3,
        selected: 2,
        stale: 1,
      },
    },
  });
  const memory = collector.summary(new Date(0), new Date(1)).context
    .projectMemory;
  assert.deepEqual(memory, {
    candidates: 12,
    injectedBytes: 620,
    relevant: 3,
    requests: 1,
    selected: 2,
    stale: 1,
  });
});

function usageEvent(inputTokens: number): AgentEvent {
  return { type: "usage", payload: { usage: { inputTokens } } };
}

function toolEvent(phase: "finished" | "started"): AgentEvent {
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
): AgentEvent {
  return {
    type: "tool",
    payload: {
      output,
      phase: "finished",
      toolCall: { id: tool, input, name: tool },
    },
  };
}

function compositionEvent(
  requestIndex: number,
  composedBytes: number,
  projectedBytesSaved: number,
  duplicateBytes: number,
): AgentEvent {
  return {
    type: "notice",
    payload: {
      kind: "context_composed",
      metrics: {
        categories: { "tool_input.edit_code": 250 },
        composedBytes,
        duplicateBytes,
        messageBytes: requestIndex === 1 ? 500 : 600,
        projectedBytesSaved,
        requestIndex,
        staleReadsReplaced: 1,
        successfulEditsReplaced: 2,
        validatedEditsReplaced: 3,
        systemPromptBytes: 300,
        toolDefinitionBytes: 150,
      },
      phase: "completed",
    },
  };
}
