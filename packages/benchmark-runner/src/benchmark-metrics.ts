import type { BenchmarkEvent } from "./engine-events.js";
import type {
  BenchmarkMetrics,
  BenchmarkNamedToolMetrics,
} from "./contracts.js";

type ToolSpan = {
  finishedAt: number;
  inputBytes: number;
  outputBytes: number;
  startedAt: number;
  tool: string;
  usageCount: number;
};

type ActiveTool = {
  input: unknown;
  startedAt: number;
  tool: string;
};

export class BenchmarkMetricsCollector {
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly inputTokens: number[] = [];
  private iterationStartEvents = 0;
  private requestAttempts = 0;
  private completedResponses = 0;
  private usageReportEvents = 0;
  private readonly spans: ToolSpan[] = [];
  private readonly toolsByName = new Map<string, BenchmarkNamedToolMetrics>();
  private compactions = 0;
  private deduplicatedReads = 0;
  private editAttempts = 0;
  private editBlocked = 0;
  private editSuccesses = 0;
  private firstEditAttemptAt: number | undefined;
  private firstEditSuccessAt: number | undefined;
  private hybridCalls = 0;
  private navigationBytes = 0;
  private patchOperations = 0;
  private readCalls = 0;
  private searchCalls = 0;
  private symbolOperations = 0;

  record(event: BenchmarkEvent, recordedAt = Date.now()) {
    if (event.type === "usage") return this.recordUsage(event);
    if (event.type === "notice") return this.recordNotice(event);
    if (event.type !== "tool") return;
    this.recordTool(event, recordedAt);
  }

  summary(startedAt: Date, finishedAt: Date): BenchmarkMetrics {
    this.attributeReplayExposure();
    const toolsByName = Object.fromEntries(this.toolsByName);
    const tools = totalToolMetrics(toolsByName);
    return {
      context: this.contextMetrics(tools),
      editing: this.editingMetrics(startedAt),
      navigation: this.navigationMetrics(),
      toolFreeGaps: toolFreeGaps(this.spans, startedAt, finishedAt),
      tools,
      toolsByName,
    };
  }

  private recordUsage(event: BenchmarkEvent) {
    this.usageReportEvents += 1;
    if (recordValue(event.payload).source !== "compaction")
      this.completedResponses += 1;
    const usage = recordValue(recordValue(event.payload).usage);
    const inputTokens = numberValue(usage.inputTokens);
    if (inputTokens !== undefined && inputTokens >= 0) this.inputTokens.push(inputTokens);
  }

  private recordNotice(event: BenchmarkEvent) {
    const payload = recordValue(event.payload);
    const kind = stringValue(payload.kind) ?? stringValue(payload.reason) ?? "";
    const message = stringValue(payload.message) ?? "";
    if (message === "Agent iteration started.") {
      this.requestAttempts += 1;
      if (numberValue(payload.attempt) === 1) this.iterationStartEvents += 1;
    }
    if (kind.includes("compaction") && payload.phase === "completed")
      this.compactions += 1;
    else if (message.endsWith("compacted")) this.compactions += 1;
  }

  private recordTool(event: BenchmarkEvent, recordedAt: number) {
    const payload = recordValue(event.payload);
    const call = recordValue(payload.toolCall);
    const tool =
      stringValue(payload.toolName) ?? stringValue(call.name) ?? "unknown";
    const id = stringValue(payload.toolCallId) ?? stringValue(call.id) ?? tool;
    if (payload.phase === "started")
      this.activeTools.set(id, {
        input: call.input,
        startedAt: recordedAt,
        tool,
      });
    if (payload.phase === "finished")
      this.finishTool(id, tool, call.input, payload, recordedAt);
  }

  private finishTool(
    id: string,
    fallbackTool: string,
    fallbackInput: unknown,
    payload: Record<string, unknown>,
    finishedAt: number,
  ) {
    const active = this.activeTools.get(id);
    this.activeTools.delete(id);
    const tool = active?.tool ?? fallbackTool;
    const input = active?.input ?? fallbackInput;
    // The harness's raw result (from its trace), or what the model read.
    const output = payload.output;
    const metric = this.namedToolMetric(tool);
    const inputBytes = serializedBytes(input);
    const outputBytes = serializedBytes(payload.output);
    updateToolMetric(metric, inputBytes, outputBytes, output, payload);
    this.spans.push({
      finishedAt,
      inputBytes,
      outputBytes,
      startedAt: active?.startedAt ?? finishedAt,
      tool,
      usageCount: this.inputTokens.length,
    });
    this.recordToolKind(
      tool,
      input,
      output,
      active?.startedAt ?? finishedAt,
      finishedAt,
    );
  }

  private namedToolMetric(tool: string) {
    const existing = this.toolsByName.get(tool);
    if (existing) return existing;
    const metric = emptyNamedToolMetrics();
    this.toolsByName.set(tool, metric);
    return metric;
  }

  private recordToolKind(
    tool: string,
    input: unknown,
    output: unknown,
    startedAt: number,
    finishedAt: number,
  ) {
    if (tool === "edit_code") this.recordEdit(input, output, startedAt, finishedAt);
    if (tool === "read_code") this.recordRead(output);
    if (tool === "search_code") this.recordSearch(output);
  }

  private recordEdit(
    input: unknown,
    output: unknown,
    startedAt: number,
    finishedAt: number,
  ) {
    this.editAttempts += 1;
    this.firstEditAttemptAt ??= startedAt;
    const operations = arrayValue(recordValue(input).operations).map(recordValue);
    const kinds = new Set(operations.map(({ kind }) => kind));
    this.symbolOperations += operations.filter(
      ({ kind }) => kind === "symbol",
    ).length;
    this.patchOperations += operations.filter(
      ({ kind }) => kind === "patch",
    ).length;
    if (kinds.has("symbol") && kinds.has("patch")) this.hybridCalls += 1;
    if (editRejected(output)) this.editBlocked += 1;
    if (!editSucceeded(output)) return;
    this.editSuccesses += 1;
    this.firstEditSuccessAt ??= finishedAt;
  }

  private recordRead(output: unknown) {
    this.readCalls += 1;
    const data = recordValue(recordValue(output).data);
    if (data.status === "already_in_context") this.deduplicatedReads += 1;
    this.navigationBytes += serializedBytes(output);
  }

  private recordSearch(output: unknown) {
    this.searchCalls += 1;
    this.navigationBytes += serializedBytes(output);
  }

  private contextMetrics(tools: BenchmarkNamedToolMetrics) {
    const totalInput = this.inputTokens.reduce((sum, value) => sum + value, 0);
    return {
      averageInputTokens: this.inputTokens.length ? roundedAverage(totalInput, this.inputTokens.length) : null,
      compactions: this.compactions,
      maximumInputTokens: this.inputTokens.length ? Math.max(...this.inputTokens) : null,
      modelRequests: this.requestAttempts,
      requestObservations: {
        schemaVersion: "request-observations-v1" as const,
        // The engine records every request it sends, retries included, and
        // every complete reply.
        coverage: "engine_records" as const,
        iterationStartEvents: this.iterationStartEvents,
        usageReportEvents: this.usageReportEvents,
        inputTokenReportEvents: this.inputTokens.length,
        transportAttempts: this.requestAttempts,
        completedResponses: this.completedResponses,
      },
      toolPayloadBytes: tools.inputBytes + tools.outputBytes,
      toolPayloadReplayExposureBytes: this.replayExposureBytes(),
    };
  }

  private replayExposureBytes() {
    const requests = this.inputTokens.length;
    return this.spans.reduce(
      (total, span) =>
        total +
        (span.inputBytes + span.outputBytes) *
          Math.max(0, requests - span.usageCount),
      0,
    );
  }

  private attributeReplayExposure() {
    for (const metric of this.toolsByName.values())
      metric.replayExposureBytes = 0;
    const requests = this.inputTokens.length;
    for (const span of this.spans) {
      const metric = this.toolsByName.get(span.tool);
      if (!metric) continue;
      metric.replayExposureBytes +=
        (span.inputBytes + span.outputBytes) *
        Math.max(0, requests - span.usageCount);
    }
  }

  private editingMetrics(startedAt: Date) {
    return {
      attempts: this.editAttempts,
      blocked: this.editBlocked,
      ...(this.firstEditAttemptAt === undefined
        ? {}
        : { firstAttemptMs: this.firstEditAttemptAt - startedAt.getTime() }),
      ...(this.firstEditSuccessAt === undefined
        ? {}
        : { firstSuccessMs: this.firstEditSuccessAt - startedAt.getTime() }),
      hybridCalls: this.hybridCalls,
      patchOperations: this.patchOperations,
      successful: this.editSuccesses,
      symbolOperations: this.symbolOperations,
    };
  }

  private navigationMetrics() {
    return {
      deduplicatedReads: this.deduplicatedReads,
      readCalls: this.readCalls,
      returnedBytes: this.navigationBytes,
      searchCalls: this.searchCalls,
    };
  }
}

function updateToolMetric(
  metric: BenchmarkNamedToolMetrics,
  inputBytes: number,
  outputBytes: number,
  output: unknown,
  payload: Record<string, unknown>,
) {
  const result = recordValue(output);
  metric.calls += 1;
  metric.inputBytes += inputBytes;
  metric.outputBytes += outputBytes;
  if (result.status === "blocked") metric.blockedCalls += 1;
  if (payload.success === false || outputFailed(output))
    metric.failedCalls += 1;
}

function editRejected(output: unknown) {
  const result = recordValue(output);
  return result.status === "blocked" || outputFailed(output);
}

function editSucceeded(output: unknown) {
  const result = recordValue(output);
  return result.status === "ok" && recordValue(result.data).changed === true;
}

function outputFailed(output: unknown): boolean {
  if (Array.isArray(output)) return output.some((item) => outputFailed(item));
  const result = recordValue(output);
  return (
    result.status === "failed" ||
    result.isError === true ||
    result.success === false
  );
}

function totalToolMetrics(tools: Record<string, BenchmarkNamedToolMetrics>) {
  const total = emptyNamedToolMetrics();
  for (const metric of Object.values(tools)) {
    total.calls += metric.calls;
    total.inputBytes += metric.inputBytes;
    total.outputBytes += metric.outputBytes;
    total.blockedCalls += metric.blockedCalls;
    total.failedCalls += metric.failedCalls;
    total.replayExposureBytes += metric.replayExposureBytes;
  }
  return { ...total, distinctTools: Object.keys(tools).length };
}

function toolFreeGaps(spans: ToolSpan[], startedAt: Date, finishedAt: Date) {
  const intervals = mergedIntervals(spans);
  const gaps = intervalGaps(
    intervals,
    startedAt.getTime(),
    finishedAt.getTime(),
  );
  const longGaps = gaps.filter((duration) => duration > 30_000);
  return {
    countOverThirtySeconds: longGaps.length,
    maximumMs: Math.max(0, ...gaps),
    totalOverThirtySecondsMs: longGaps.reduce((sum, value) => sum + value, 0),
  };
}

function mergedIntervals(spans: ToolSpan[]) {
  const ordered = spans
    .map(({ startedAt, finishedAt }) => [startedAt, finishedAt] as const)
    .sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ordered) mergeInterval(merged, start, end);
  return merged;
}

function mergeInterval(
  intervals: Array<[number, number]>,
  start: number,
  end: number,
) {
  const previous = intervals.at(-1);
  if (!previous || start > previous[1]) intervals.push([start, end]);
  else previous[1] = Math.max(previous[1], end);
}

function intervalGaps(
  intervals: Array<[number, number]>,
  startedAt: number,
  finishedAt: number,
) {
  const gaps: number[] = [];
  let cursor = startedAt;
  for (const [start, end] of intervals) {
    if (start > cursor) gaps.push(start - cursor);
    cursor = Math.max(cursor, end);
  }
  if (finishedAt > cursor) gaps.push(finishedAt - cursor);
  return gaps;
}

function emptyNamedToolMetrics(): BenchmarkNamedToolMetrics {
  return {
    blockedCalls: 0,
    calls: 0,
    failedCalls: 0,
    inputBytes: 0,
    outputBytes: 0,
    replayExposureBytes: 0,
  };
}

function roundedAverage(total: number, count: number) {
  return count ? Math.round((total / count) * 100) / 100 : 0;
}

function serializedBytes(value: unknown) {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Buffer.byteLength(String(value));
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
