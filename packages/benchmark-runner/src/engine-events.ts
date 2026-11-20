// A benchmark run's events, from its engine session's records and the
// harness trace (each harness call's raw result, which the records do not
// keep: they hold what the model read). The events keep the shapes the
// benchmark's consumers read in events.jsonl: tool calls with their raw
// harness output, usage reports with running totals, notices, and one
// terminal `done` or `error`.
import type { SessionRecord, Usage } from "@blame/engine-client";

export type BenchmarkEvent = {
  type: "done" | "error" | "notice" | "tool" | "usage";
  sessionId: string;
  payload: Record<string, unknown>;
};

/** One line of the harness trace (`BLAME_HARNESS_TRACE_FILE`). */
export type HarnessTraceEntry = {
  at: number;
  toolCallId?: string;
  tool: string;
  input?: unknown;
  raw?: unknown;
  presented?: unknown;
};

export type TimedBenchmarkEvent = { at: number; event: BenchmarkEvent };

/** What finish_task left, when the harness accepted it. */
export type BenchmarkCompletion = {
  completion?: unknown;
  verified?: boolean;
  summary?: string;
};

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
};

export function benchmarkEvents(
  session: string,
  records: SessionRecord[],
  trace: HarnessTraceEntry[],
): TimedBenchmarkEvent[] {
  const raw = new Map(
    trace.flatMap((entry) =>
      entry.toolCallId ? [[entry.toolCallId, entry] as const] : [],
    ),
  );
  const calls = new Map<string, { name: string; input: unknown }>();
  const totals = emptyTotals();
  const events: TimedBenchmarkEvent[] = [];
  const push = (at: number, type: BenchmarkEvent["type"], payload: Record<string, unknown>) =>
    events.push({ at, event: { type, sessionId: session, payload } });
  let iteration = 0;
  for (const record of records) {
    switch (record.type) {
      case "request_started":
        if (record.attempt === 1) iteration += 1;
        push(record.at_ms, "notice", {
          message: "Agent iteration started.",
          iteration,
          attempt: record.attempt,
        });
        break;
      case "assistant_message":
        for (const block of record.blocks)
          if (block.type === "tool_call")
            calls.set(block.call, { name: block.name, input: block.input });
        push(record.at_ms, "usage", { usage: usagePayload(record.usage, totals) });
        break;
      case "context_compacted":
        push(record.at_ms, "notice", { kind: "compaction", phase: "completed" });
        push(record.at_ms, "usage", {
          source: "compaction",
          usage: usagePayload(record.usage, totals),
        });
        break;
      case "request_failed":
        push(record.at_ms, "notice", {
          kind: "request_failed",
          message: record.error.message,
        });
        break;
      case "tool_call_started": {
        const call = calls.get(record.call);
        push(record.at_ms, "tool", {
          phase: "started",
          toolName: record.name,
          toolCallId: record.call,
          toolCall: { id: record.call, name: record.name, input: call?.input },
        });
        break;
      }
      case "tool_call_finished": {
        const call = calls.get(record.call);
        const traced = raw.get(record.call);
        push(record.at_ms, "tool", {
          phase: "finished",
          toolName: call?.name ?? traced?.tool,
          toolCallId: record.call,
          toolCall: { id: record.call, name: call?.name, input: call?.input },
          // The harness's own result when it ran the call; else what the
          // model read (client tools, refusals the engine wrote).
          output: traced ? traced.raw : record.content,
          success: record.outcome === "completed",
        });
        break;
      }
      case "turn_ended": {
        const finish = acceptedFinish(trace);
        if (record.outcome.status === "completed")
          push(record.at_ms, "done", {
            reason: "completed",
            text: finish.summary,
            completion: finish.completion,
            verified: finish.verified,
            usage: { ...totalsPayload(totals) },
          });
        else
          push(record.at_ms, "error", {
            reason: record.outcome.status,
            message: outcomeMessage(record.outcome),
          });
        break;
      }
    }
  }
  return events;
}

/** The run's token usage, as `result.usage` reports it. */
export function usageSummary(records: SessionRecord[]) {
  const totals = emptyTotals();
  for (const record of records)
    if (record.type === "assistant_message" || record.type === "context_compacted")
      usagePayload(record.usage, totals);
  const usage = {
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    ...totalsPayload(totals),
  };
  return { usage, aggregateUsage: usage };
}

/** What the last finish_task the harness accepted said. */
export function acceptedFinish(trace: HarnessTraceEntry[]): BenchmarkCompletion {
  const finish = trace
    .filter(
      (entry) => entry.tool === "finish_task" && record(entry.raw).status === "ok",
    )
    .at(-1);
  const notification = record(record(record(finish?.raw).data).notification);
  return {
    completion: notification.completion,
    ...(typeof notification.verified === "boolean"
      ? { verified: notification.verified }
      : {}),
    ...(typeof notification.summary === "string"
      ? { summary: notification.summary }
      : {}),
  };
}

function usagePayload(usage: Usage, totals: UsageTotals) {
  const cost = usage.cost_micro_usd === undefined ? undefined : usage.cost_micro_usd / 1e6;
  totals.inputTokens += usage.input_tokens ?? 0;
  totals.outputTokens += usage.output_tokens ?? 0;
  totals.cacheReadTokens += usage.cache_read_tokens ?? 0;
  totals.cacheWriteTokens += usage.cache_write_tokens ?? 0;
  totals.cost += cost ?? 0;
  return {
    type: "usage",
    ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
    ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
    ...(usage.cache_read_tokens === undefined
      ? {}
      : { cacheReadTokens: usage.cache_read_tokens }),
    ...(usage.cache_write_tokens === undefined
      ? {}
      : { cacheWriteTokens: usage.cache_write_tokens }),
    ...(cost === undefined ? {} : { cost }),
    ...totalsPayload(totals),
  };
}

function totalsPayload(totals: UsageTotals) {
  return {
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    totalCacheReadTokens: totals.cacheReadTokens,
    totalCacheWriteTokens: totals.cacheWriteTokens,
    totalCost: Math.round(totals.cost * 1e6) / 1e6,
  };
}

function outcomeMessage(outcome: Extract<SessionRecord, { type: "turn_ended" }>["outcome"]) {
  switch (outcome.status) {
    case "failed":
      return outcome.error.message;
    case "contract_unmet":
      return "The agent stopped without a finish_task the harness accepted.";
    case "limit_reached":
      return `The run stopped at its ${outcome.limit} limit.`;
    default:
      return `The run ended ${outcome.status}.`;
  }
}

function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
