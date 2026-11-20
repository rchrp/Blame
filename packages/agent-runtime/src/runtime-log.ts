// Blame's local run logs (`<worktree>/.blame/logs`): one JSON record per
// line, with only the attributes known to be safe. No runtime import: the
// engine host's git flows write them as the Cline runtime does.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactSecuritySecrets } from "./security-secret-redaction.js";

const secretKeys = [
  "access",
  "apiKey",
  "authorization",
  "headers",
  "oauthCredentials",
  "refresh",
  "token",
];

const allowedLogKeys = new Set([
  "cacheReadTokens",
  "cacheWriteTokens",
  "capsuleHash",
  "ccrHashCount",
  "checkpointEnabled",
  "compressed",
  "compactedEventHash",
  "compressionRatio",
  "contextUtilizationRatio",
  "configExtensions",
  "cost",
  "disableMcpSettingsTools",
  "durationMs",
  "errorType",
  "estimatedInputTokens",
  "fallback",
  "inputTokens",
  "maxIterations",
  "maxInputTokens",
  "messageBuilderMaxToolResultChars",
  "messageBuilderMaxTotalTextBytes",
  "messageBuilderMinOutdatedRewriteBytes",
  "messageCount",
  "messageCountAfter",
  "messageCountBefore",
  "maxParallelToolCalls",
  "mode",
  "modelId",
  "outputTokens",
  "promptLength",
  "providerId",
  "pluginPathCount",
  "sessionId",
  "status",
  "storyId",
  "success",
  "tailMessages",
  "targetTokens",
  "toolName",
  "toolResultTokens",
  "totalCacheReadTokens",
  "totalCacheWriteTokens",
  "totalCost",
  "totalInputTokens",
  "totalOutputTokens",
  "tokensAfter",
  "tokensBefore",
  "tokensSaved",
  "transformsApplied",
  "triggerTokens",
]);

const stableStringLogKeys = new Set([
  "capsuleHash",
  "compactedEventHash",
  "errorType",
  "mode",
  "modelId",
  "providerId",
  "sessionId",
  "status",
  "storyId",
  "toolName",
]);

const stableStringPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export function approveMergeLogPath(worktree: string) {
  return join(worktree, ".blame", "logs", "approve-merge.log");
}

export function commitMessageLogPath(worktree: string) {
  return join(worktree, ".blame", "logs", "commit-message.log");
}

export function mergeConflictLogPath(worktree: string) {
  return join(worktree, ".blame", "logs", "merge-conflicts.log");
}

export function pullRequestLogPath(worktree: string) {
  return join(worktree, ".blame", "logs", "pull-request.log");
}

export function startLogPath(cwd: string) {
  return join(cwd, ".blame", "logs", "cline-start.log");
}

export function sessionLogPath(cwd: string, sessionId: string) {
  return join(cwd, ".blame", "logs", `cline-${sessionId}.log`);
}

export async function appendLog(
  file: string,
  message: string,
  payload?: unknown,
) {
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(
      file,
      `${JSON.stringify(logLine(message, payload))}\n`,
      "utf8",
    );
  } catch {
    console.warn("[blame-agent]", "log write failed");
  }
}

function logLine(message: string, payload?: unknown) {
  const attributes = safeLogPayload(payload);
  return logRecord(logSeverity(attributes), logEventName(message), attributes);
}

function logEventName(message: string) {
  return `blame.agent.${message.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

function logSeverity(attributes: Record<string, unknown>) {
  const status = attributes.status;
  return status === "failed" || status === "error" ? "error" : "info";
}

export type LogSeverity = "debug" | "info" | "error";

// The app reads `event_name` and `attributes` back from run logs to recover
// interrupted runs.
export function logRecord(
  severity: LogSeverity,
  eventName: string,
  attributes: Record<string, unknown>,
) {
  return {
    timestamp: new Date().toISOString(),
    severity_text: severity.toUpperCase(),
    event_name: eventName,
    attributes,
  };
}

export function safeLogPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => allowedLogKeys.has(key) && !secretKeys.includes(key))
      .map(([key, field]) => [key, safeLogValue(key, field)])
      .filter(
        (entry): entry is [string, string | number | boolean] =>
          entry[1] !== undefined,
      ),
  );
}

function safeLogValue(
  key: string,
  value: unknown,
): string | number | boolean | undefined {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "string" || !stableStringLogKeys.has(key))
    return undefined;
  const sanitizedValue = redactSecuritySecrets(value);
  if (stableStringPattern.test(sanitizedValue)) return sanitizedValue;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
