import type { CoreSessionEvent, SessionUsageSummary } from "@cline/sdk";

import {
  lightCompletionToolName,
  type LightCompletionNotification,
} from "./harness/light-completion.js";

import { type RunTerminalState } from "./harness/run-lifecycle.js";

import { summarizeUsage } from "./production.js";
import { withScreenshotRefs } from "./preview-screenshots.js";

import type { AgentEvent, AgentUsageSummary } from "./types.js";

export function streamingAgentEvent(event: AgentEvent) {
  return event.type === "text" || event.type === "reasoning";
}

export function normalizeEvent(
  sessionId: string,
  event: CoreSessionEvent,
): AgentEvent {
  const normalized = normalizeCoreEvent(sessionId, event);
  return normalized.type === "tool"
    ? withToolScreenshotRefs(normalized)
    : normalized;
}

// Tool activities are saved and synced: a stored screenshot is kept as a
// small reference there, never as base64.
function withToolScreenshotRefs(event: AgentEvent): AgentEvent {
  const payload = withScreenshotRefs(event.payload);
  return payload === event.payload ? event : { ...event, payload };
}

function normalizeCoreEvent(
  sessionId: string,
  event: CoreSessionEvent,
): AgentEvent {
  if (event.type === "chunk") {
    const parsed = parseChunkEvent(event.payload.chunk);
    if (event.payload.stream === "agent" && parsed) {
      return normalizeClineAgentPayload(
        parsed,
        event.payload.sessionId,
        parsed,
      );
    }
    return {
      type: event.payload.stream === "agent" ? "text" : "notice",
      sessionId: event.payload.sessionId,
      payload: {
        text: event.payload.chunk,
        stream: event.payload.stream,
        ts: event.payload.ts,
      },
    };
  }
  if (event.type === "hook") return normalizeHookEvent(event, sessionId);
  if (event.type === "ended")
    return incompleteTerminalStatus(event.payload.reason)
      ? terminalProductError(event.payload.sessionId, event.payload.reason)
      : {
          type: "done",
          sessionId: event.payload.sessionId,
          payload: event.payload,
        };
  if (event.type === "status")
    return {
      type: "notice",
      sessionId: event.payload.sessionId,
      payload: event.payload,
    };
  if (event.type === "agent_event")
    return normalizeAgentEvent(event, sessionId);
  return { type: "raw", sessionId, payload: event };
}

export function shouldDisplayClineSessionEvent(
  event: CoreSessionEvent,
  spawnAgentActive = false,
) {
  if (event.type === "agent_event") {
    const payload = asRecord(event.payload.event);
    if (stringValue(payload.type) === "usage") return true;
    if (event.payload.teamRole === "teammate") return false;
    if (stringValue(payload.parentAgentId)) return false;
  }
  if (event.type === "hook") {
    if (stringValue(event.payload.parentAgentId)) return false;
  }
  if (spawnAgentActive) {
    return clineSessionSpawnAgentPhase(event) !== undefined;
  }
  return true;
}

export function clineSessionSpawnAgentPhase(event: CoreSessionEvent) {
  const tool = clineSessionToolEvent(event);
  if (tool?.toolName !== "spawn_agent") return undefined;
  return tool.phase;
}

export function clineSessionToolEvent(event: CoreSessionEvent) {
  if (event.type === "agent_event") {
    const payload = asRecord(event.payload.event);
    if (stringValue(payload.contentType) !== "tool") return undefined;
    const type = stringValue(payload.type);
    const phase =
      type === "content_start"
        ? "started"
        : type === "content_end"
          ? "finished"
          : undefined;
    return clineToolActivity(payload, "agent_event", phase);
  }
  if (event.type !== "hook") return undefined;
  const phase =
    event.payload.hookEventName === "tool_call"
      ? "started"
      : event.payload.hookEventName === "tool_result"
        ? "finished"
        : undefined;
  return clineToolActivity(asRecord(event.payload), "hook", phase);
}

function clineToolActivity(
  payload: Record<string, unknown>,
  source: "agent_event" | "hook",
  phase: "started" | "finished" | undefined,
) {
  if (!phase) return undefined;
  const toolName = stringValue(payload.toolName);
  if (!toolName) return undefined;
  const toolCallId =
    stringValue(payload.toolCallId) ??
    stringValue(asRecord(payload.toolCall).id) ??
    `${source}:${toolName}`;
  return { phase, toolCallId, toolName };
}

export function nextSpawnAgentActiveCount(
  current: number,
  phase: "started" | "finished",
) {
  if (phase === "started") return current + 1;
  return Math.max(0, current - 1);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function resultStatus(payload: Record<string, unknown>) {
  return (
    stringValue(payload.status) ??
    stringValue(payload.state) ??
    stringValue(payload.finishReason) ??
    stringValue(payload.reason)
  );
}

function normalizeHookEvent(
  event: Extract<CoreSessionEvent, { type: "hook" }>,
  fallbackSessionId: string,
): AgentEvent {
  if (event.payload.hookEventName === "agent_error") {
    return normalizedErrorEvent(
      event.payload.sessionId ?? fallbackSessionId,
      asRecord(event.payload),
      event.payload,
    );
  }
  return {
    type: "tool",
    sessionId: event.payload.sessionId ?? fallbackSessionId,
    payload: event.payload,
  };
}

function normalizeAgentEvent(
  event: Extract<CoreSessionEvent, { type: "agent_event" }>,
  fallbackSessionId: string,
): AgentEvent {
  const payload = asRecord(event.payload.event);
  return normalizeClineAgentPayload(
    payload,
    event.payload.sessionId ?? fallbackSessionId,
    event.payload.event,
  );
}

export function normalizeClineAgentPayload(
  payload: Record<string, unknown>,
  sessionId: string,
  raw: unknown,
): AgentEvent {
  const type = stringValue(payload.type);

  if (type === "error") {
    return normalizedErrorEvent(sessionId, payload, raw);
  }

  if (type === "content_start" || type === "content_update") {
    return normalizeContentEvent(payload, sessionId, raw);
  }

  if (type === "content_end") {
    return normalizeContentEndEvent(payload, sessionId, raw);
  }

  if (type === "done") {
    const finishReason = stringValue(payload.finishReason);
    const incompleteStatus = incompleteResultStatus(payload);
    const reason =
      stringValue(payload.reason) ??
      finishReason ??
      stringValue(payload.status);
    if (incompleteStatus)
      return terminalProductError(
        sessionId,
        incompleteStatus,
        payload.iteration,
      );
    return {
      type: "done",
      sessionId,
      payload: {
        finishReason,
        reason,
        status: stringValue(payload.status),
        text: stringValue(payload.text),
        usage: doneUsagePayload(payload.usage),
        raw,
      },
    };
  }

  if (type === "usage") {
    return {
      type: "usage",
      sessionId,
      payload: { usage: payload, raw },
    };
  }

  if (type === "iteration_start" || type === "iteration_end") {
    return {
      type: "notice",
      sessionId,
      payload: {
        message:
          type === "iteration_start"
            ? "Agent iteration started."
            : "Agent iteration completed.",
        iteration: numberValue(payload.iteration),
        raw,
      },
    };
  }

  if (type === "assistant-reasoning-delta") {
    return {
      type: "reasoning",
      sessionId,
      payload: {
        text: stringValue(payload.text) ?? "",
        accumulatedText: stringValue(payload.accumulatedText),
        iteration: numberValue(payload.iteration),
        raw,
      },
    };
  }

  if (type === "assistant-text-delta") {
    return {
      type: "text",
      sessionId,
      payload: {
        text: stringValue(payload.text) ?? "",
        accumulatedText: stringValue(payload.accumulatedText),
        iteration: numberValue(payload.iteration),
        raw,
      },
    };
  }

  if (type === "assistant-message") {
    return {
      type: "text",
      sessionId,
      payload: {
        accumulatedText: agentMessageText(asRecord(payload.message)),
        finishReason: stringValue(payload.finishReason),
        iteration: numberValue(payload.iteration),
        raw,
      },
    };
  }

  if (
    type === "tool-started" ||
    type === "tool-updated" ||
    type === "tool-finished"
  ) {
    return {
      type: "tool",
      sessionId,
      payload: {
        phase: type.replace("tool-", ""),
        iteration: numberValue(payload.iteration),
        toolCall: payload.toolCall,
        update: payload.update,
        raw,
      },
    };
  }

  if (type === "usage-updated") {
    return {
      type: "usage",
      sessionId,
      payload: { usage: payload.usage, raw },
    };
  }

  if (type === "status-notice") {
    return {
      type: "notice",
      sessionId,
      payload: {
        message: stringValue(payload.message) ?? "Agent status updated.",
        metadata: payload.metadata,
        raw,
      },
    };
  }

  if (type === "run-finished") {
    const result = asRecord(payload.result);
    const status = stringValue(result.status);
    const incompleteStatus = incompleteResultStatus(result);
    if (incompleteStatus)
      return terminalProductError(sessionId, incompleteStatus);
    return {
      type: "done",
      sessionId,
      payload: {
        text: stringValue(result.outputText),
        status,
        raw,
      },
    };
  }

  if (type === "run-failed") {
    return {
      type: "error",
      sessionId,
      payload: normalizedErrorPayload(payload, raw),
    };
  }

  if (toolPayload(payload, type)) {
    return { type: "raw", sessionId, payload };
  }

  const text =
    stringValue(payload.text) ??
    stringValue(payload.content) ??
    stringValue(payload.delta);

  if (text) {
    return {
      type: "text",
      sessionId,
      payload: { text, raw },
    };
  }

  return {
    type: "raw",
    sessionId,
    payload,
  };
}

function toolPayload(payload: Record<string, unknown>, type?: string) {
  return (
    type?.includes("tool") === true ||
    Boolean(stringValue(payload.toolName)) ||
    Boolean(stringValue(payload.toolCallId))
  );
}

function normalizedErrorPayload(
  payload: Record<string, unknown>,
  raw: unknown,
) {
  const error = asRecord(payload.error);
  return {
    iteration: numberValue(payload.iteration),
    message:
      stringValue(error.message) ??
      stringValue(payload.message) ??
      stringValue(payload.error) ??
      "Agent session failed.",
    recoverable: booleanValue(payload.recoverable),
    raw,
  };
}

function normalizedErrorEvent(
  sessionId: string,
  payload: Record<string, unknown>,
  raw: unknown,
): AgentEvent {
  const error = normalizedErrorPayload(payload, raw);
  return {
    type: error.recoverable === true ? "notice" : "error",
    sessionId,
    payload: error,
  };
}

function terminalProductError(
  sessionId: string,
  status: unknown,
  iteration?: unknown,
): AgentEvent {
  const terminalStatus = stringValue(status) ?? "incomplete";
  return {
    type: "error",
    sessionId,
    payload: {
      iteration: numberValue(iteration),
      message: terminalProductMessage(terminalStatus),
      recoverable: false,
      terminalStatus,
    },
  };
}

export function terminalProductMessage(status: string) {
  const normalized = status.replaceAll("-", "_").toLowerCase();
  if (normalized === "max_iterations")
    return "Agent stopped after reaching its work-step limit before submitting a final response.";
  if (normalized === "mistake_limit")
    return "Agent stopped after repeated unsuccessful actions before submitting a final response.";
  if (normalized === "aborted" || normalized === "cancelled")
    return "Agent work was interrupted before a final response was submitted.";
  return "Agent stopped before submitting a final response.";
}

export function completionFailureEvent(
  sessionId: string,
  notification: LightCompletionNotification | undefined,
): AgentEvent {
  return {
    type: "error",
    sessionId,
    payload: {
      completion: notification?.completion,
      message:
        notification?.summary ??
        "Completion was blocked because required evidence was unavailable.",
      recoverable: false,
      terminalStatus: "failed",
    },
  };
}

export function terminalLifecycleState(
  event: AgentEvent,
): RunTerminalState | undefined {
  if (event.type === "done") {
    const payload = asRecord(event.payload);
    return terminalStateFromStatus(
      stringValue(payload.status) ??
        stringValue(payload.reason) ??
        stringValue(payload.finishReason),
      "succeeded",
    );
  }
  if (event.type !== "error") return undefined;
  const payload = asRecord(event.payload);
  if (payload.recoverable === true) return undefined;
  return terminalStateFromStatus(
    stringValue(payload.terminalStatus) ?? stringValue(payload.status),
    "failed",
  );
}

export function transportFailureEventMessage(event: AgentEvent) {
  if (event.type !== "error") return undefined;
  const payload = asRecord(event.payload);
  const error = asRecord(payload.error);
  const message =
    stringValue(payload.message) ??
    stringValue(error.message) ??
    stringValue(payload.error);
  return message && retryableModelTransportFailure(message)
    ? message
    : undefined;
}

export function retryableModelTransportFailure(error: unknown) {
  const value = asRecord(error);
  const cause = asRecord(value.cause);
  const message = [
    errorMessage(error),
    stringValue(value.code),
    stringValue(cause.code),
    stringValue(cause.message),
  ]
    .filter(Boolean)
    .join(" ");
  if (nonRetryableProviderFailure(message)) return false;
  return transportInterruption(message) || transientProviderFailure(message);
}

function transportInterruption(message: string) {
  return /(?:UND_ERR_(?:SOCKET|BODY_TIMEOUT|CONNECT_TIMEOUT|HEADERS_TIMEOUT)|ECONNRESET|EPIPE|ERR_STREAM_PREMATURE_CLOSE|terminated[^\n]*socket|socket[^\n]*other side closed)/iu.test(
    message,
  );
}

function transientProviderFailure(message: string) {
  return /(?:an error occurred while processing your request[\s\S]{0,500}(?:retry|request id)|internal server error|service temporarily unavailable|provider[^\n]*(?:overloaded|unavailable)|(?:http|status(?: code)?)\s*50[0234]\b)/iu.test(
    message,
  );
}

function nonRetryableProviderFailure(message: string) {
  return /(?:\b(?:401|403|429)\b|api[_ -]?key|authentication|authorization|billing|content policy|insufficient quota|invalid request|rate limit)/iu.test(
    message,
  );
}

export function terminalStateFromResult(result: unknown): RunTerminalState {
  const payload = asRecord(result);
  return terminalStateFromStatus(incompleteResultStatus(payload), "failed");
}

function terminalStateFromStatus(
  status: string | undefined,
  fallback: RunTerminalState,
): RunTerminalState {
  const normalized = status?.replaceAll("-", "_").toLowerCase();
  if (normalized === "max_iterations" || normalized === "mistake_limit")
    return "failed";
  if (
    normalized === "aborted" ||
    normalized === "cancelled" ||
    normalized === "canceled"
  )
    return "cancelled";
  if (normalized === "failed" || normalized === "error") return "failed";
  return fallback;
}

export function eventTokenCount(event: CoreSessionEvent) {
  const usage = findUsageRecord(event);
  const totals =
    (numberValue(usage.totalInputTokens) ?? 0) +
    (numberValue(usage.totalOutputTokens) ?? 0) +
    (numberValue(usage.totalCacheWriteTokens) ?? 0);
  if (totals > 0) return totals;
  return (
    (numberValue(usage.inputTokens) ?? 0) +
    (numberValue(usage.outputTokens) ?? 0) +
    (numberValue(usage.cacheWriteTokens) ?? 0)
  );
}

function findUsageRecord(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 6 || !value || typeof value !== "object") return {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUsageRecord(item, depth + 1);
      if (Object.keys(found).length) return found;
    }
    return {};
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) =>
      /^(?:total)?(?:input|output|cacheWrite)Tokens$/u.test(key),
    )
  )
    return record;
  for (const item of Object.values(record)) {
    const found = findUsageRecord(item, depth + 1);
    if (Object.keys(found).length) return found;
  }
  return {};
}

function incompleteTerminalStatus(status: unknown) {
  const value = stringValue(status)?.replaceAll("-", "_").toLowerCase();
  return [
    "aborted",
    "cancelled",
    "error",
    "failed",
    "max_iterations",
    "mistake_limit",
  ].includes(value ?? "");
}

export function incompleteResultStatus(payload: Record<string, unknown>) {
  return [payload.status, payload.state, payload.finishReason, payload.reason]
    .map(stringValue)
    .find(incompleteTerminalStatus);
}

export function eventLogPayload(event: AgentEvent) {
  const payload = asRecord(event.payload);
  if (event.type === "usage")
    return summarizeUsage({ aggregateUsage: asRecord(payload.usage) as never });
  if (event.type === "tool") return toolLogPayload(payload);
  if (event.type === "done") return doneLogPayload(payload);
  if (event.type === "error") return errorLogPayload(payload);
  return {
    sessionId: event.sessionId,
    status: event.type,
  };
}

export function duplicateEventSignature(event: AgentEvent) {
  if (event.type === "raw") return undefined;
  if (event.type === "text" || event.type === "reasoning") return undefined;
  const payload = asRecord(event.payload);
  const tool = toolNameFromPayload(payload);
  if (tool === "spawn_agent") return undefined;
  if (event.type === "tool") {
    const toolCallId =
      stringValue(payload.toolCallId) ??
      stringValue(asRecord(payload.toolCall).id);
    const phase = stringValue(payload.phase);
    const sequenceNumber = numberValue(payload.sequenceNumber);
    if (!toolCallId || !phase || sequenceNumber === undefined) return undefined;
    return [event.sessionId, toolCallId, phase, sequenceNumber].join(":");
  }
  const text = eventText(payload);
  const value =
    text || tool || stringValue(payload.reason) || stringValue(payload.status);
  if (!value) return undefined;
  return [event.type, event.sessionId, value].join(":");
}

export function normalizedToolPhase(payload: Record<string, unknown>) {
  const current = stringValue(payload.phase);
  if (current === "updated" || current === "progress") return "progress";
  if (current === "cancelled" || toolEventStatus(payload) === "cancelled")
    return "cancelled";
  if (current === "failed" || toolEventStatus(payload) === "failed")
    return "failed";
  if (current === "finished") return "finished";
  if (payload.hookEventName === "tool_result") return "finished";
  return "started";
}

function toolEventStatus(payload: Record<string, unknown>) {
  const output = asRecord(payload.output ?? payload.result);
  if (booleanValue(output.isError)) return "failed";
  const status = stringValue(output.status) ?? stringValue(payload.status);
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return status === "error" ? "failed" : undefined;
}

export function removeOldEventSignatures(
  signatures: Map<string, number>,
  now: number,
) {
  for (const [signature, timestamp] of signatures.entries()) {
    if (now - timestamp > 1_000) signatures.delete(signature);
  }
}

function eventText(payload: Record<string, unknown>) {
  return (
    stringValue(payload.text) ??
    stringValue(payload.message) ??
    stringValue(payload.accumulatedText)
  );
}

export function lightTerminalState(state: RunTerminalState) {
  if (state === "succeeded") return "completed";
  if (state === "cancelled") return "cancelled";
  return "harness_failure";
}

function toolNameFromPayload(payload: Record<string, unknown>) {
  const toolCall = asRecord(payload.toolCall);
  return (
    stringValue(toolCall.name) ??
    stringValue(toolCall.toolName) ??
    stringValue(payload.toolName)
  );
}

export function terminalToolEvent(event: AgentEvent) {
  return (
    event.type === "tool" &&
    toolNameFromPayload(asRecord(event.payload)) === lightCompletionToolName
  );
}

export function eventUsageSummary(
  event: AgentEvent,
): AgentUsageSummary | undefined {
  if (event.type !== "usage" && event.type !== "done") return undefined;
  const payload = asRecord(event.payload);
  const usage = asRecord(payload.usage);
  if (!Object.keys(usage).length) return undefined;
  return { aggregateUsage: usage as never };
}

function doneUsagePayload(value: unknown) {
  const usage = asRecord(value);
  if (!Object.keys(usage).length || usageHasTotals(usage)) return value;
  return {
    totalCacheReadTokens: usage.cacheReadTokens,
    totalCacheWriteTokens: usage.cacheWriteTokens,
    totalCost: usage.totalCost,
    totalInputTokens: usage.inputTokens,
    totalOutputTokens: usage.outputTokens,
  };
}

function usageHasTotals(usage: Record<string, unknown>) {
  return (
    usage.totalInputTokens !== undefined ||
    usage.totalOutputTokens !== undefined ||
    usage.totalCacheReadTokens !== undefined ||
    usage.totalCacheWriteTokens !== undefined
  );
}

export function normalizeAgentUsageSummary(
  summary: SessionUsageSummary | undefined,
): AgentUsageSummary | undefined {
  if (!summary) return undefined;
  return {
    usage: normalizeAgentUsageTotals(summary.usage),
    aggregateUsage: normalizeAgentUsageTotals(summary.aggregateUsage),
  };
}

function normalizeAgentUsageTotals(
  usage: SessionUsageSummary["usage"] | undefined,
) {
  if (!usage) return undefined;
  const totalUsage = usage as SessionUsageSummary["usage"] & {
    totalCacheReadTokens?: number;
    totalCacheWriteTokens?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
  };
  return {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalCacheReadTokens:
      totalUsage.totalCacheReadTokens ?? usage.cacheReadTokens,
    totalCacheWriteTokens:
      totalUsage.totalCacheWriteTokens ?? usage.cacheWriteTokens,
    totalCost: usage.totalCost,
    totalInputTokens: totalUsage.totalInputTokens ?? usage.inputTokens,
    totalOutputTokens: totalUsage.totalOutputTokens ?? usage.outputTokens,
  };
}

function toolLogPayload(payload: Record<string, unknown>) {
  return {
    durationMs: numberValue(payload.durationMs),
    status: stringValue(payload.phase),
    success: stringValue(payload.phase) !== "failed",
    toolName: toolNameFromPayload(payload),
  };
}

function doneLogPayload(payload: Record<string, unknown>) {
  return {
    finishReason:
      stringValue(payload.reason) ?? stringValue(payload.finishReason),
    status: stringValue(payload.status) ?? "done",
    ...summarizeUsage({ aggregateUsage: asRecord(payload.usage) as never }),
  };
}

function errorLogPayload(payload: Record<string, unknown>) {
  const error = asRecord(payload.error);
  return {
    errorType: stringValue(error.name) ?? "Error",
    message: stringValue(payload.message) ?? stringValue(error.message),
    status: "failed",
  };
}

export function sendResultLogPayload(result: unknown, durationMs: number) {
  const payload = asRecord(result);
  return {
    durationMs,
    finishReason:
      stringValue(payload.finishReason) ?? stringValue(payload.reason),
    status: resultStatus(payload) ?? "completed",
    ...summarizeUsage({ aggregateUsage: asRecord(payload.usage) as never }),
  };
}

export function doneResultPayload(result: unknown) {
  const payload = asRecord(result);
  const status = resultStatus(payload);
  const finishReason = stringValue(payload.finishReason);
  const incompleteStatus = incompleteResultStatus(payload);
  return {
    finishReason,
    iterations: numberValue(payload.iterations),
    reason: stringValue(payload.reason) ?? finishReason ?? status,
    status,
    text: incompleteStatus
      ? undefined
      : (stringValue(payload.text) ?? stringValue(payload.outputText)),
    usage: payload.usage,
  };
}

function normalizeContentEvent(
  payload: Record<string, unknown>,
  sessionId: string,
  raw: unknown,
): AgentEvent {
  const contentType = stringValue(payload.contentType);
  if (contentType === "tool") {
    return {
      type: "tool",
      sessionId,
      payload: {
        phase:
          stringValue(payload.type) === "content_update"
            ? "progress"
            : "started",
        toolCall: {
          id: stringValue(payload.toolCallId),
          name: stringValue(payload.toolName),
          input: payload.input,
        },
        ...(payload.update === undefined ? {} : { update: payload.update }),
        raw,
      },
    };
  }
  if (contentType === "reasoning" || contentType === "thinking") {
    return {
      type: "reasoning",
      sessionId,
      payload: {
        text: stringValue(payload.reasoning) ?? stringValue(payload.text) ?? "",
        phase: "started",
        redacted: booleanValue(payload.redacted),
        raw,
      },
    };
  }
  return {
    type: "text",
    sessionId,
    payload: {
      text: stringValue(payload.text) ?? "",
      phase: "started",
      raw,
    },
  };
}

function normalizeContentEndEvent(
  payload: Record<string, unknown>,
  sessionId: string,
  raw: unknown,
): AgentEvent {
  if (stringValue(payload.contentType) === "tool") {
    return {
      type: "tool",
      sessionId,
      payload: {
        durationMs: numberValue(payload.durationMs),
        output: payload.output,
        phase: "finished",
        toolCall: {
          id: stringValue(payload.toolCallId),
          name: stringValue(payload.toolName),
          input: payload.input,
        },
        raw,
      },
    };
  }
  if (
    stringValue(payload.contentType) === "reasoning" ||
    stringValue(payload.contentType) === "thinking"
  ) {
    return {
      type: "reasoning",
      sessionId,
      payload: { phase: "finished", raw },
    };
  }
  return {
    type: "text",
    sessionId,
    payload: { phase: "finished", raw },
  };
}

function agentMessageText(message: Record<string, unknown>) {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content.map(agentMessagePartText).join("");
}

function agentMessagePartText(value: unknown) {
  const part = asRecord(value);
  if (stringValue(part.type) !== "text") return "";
  return stringValue(part.text) ?? "";
}

export function asRecord(value: unknown) {
  if (value && typeof value === "object")
    return value as Record<string, unknown>;
  return {};
}

export function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function parseChunkEvent(value: string) {
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

export function errorType(error: unknown) {
  return error instanceof Error ? error.constructor.name : "Error";
}
