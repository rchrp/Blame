import { appendFile, mkdir } from "node:fs/promises";

import { dirname, join } from "node:path";

import { getBlameTelemetry } from "@blame/telemetry";

import { asRecord, stringValue } from "./cline-runtime-events.js";

import { safeLogPayload } from "./production.js";

export const blameTelemetry = getBlameTelemetry();

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
  activeContext?: import("@blame/telemetry").Context,
) {
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(
      file,
      `${JSON.stringify(logLine(message, safeLogPayload(payload), activeContext))}\n`,
      "utf8",
    );
  } catch {
    console.warn("[blame-agent]", "log write failed");
  }
}

function logLine(
  message: string,
  payload?: unknown,
  activeContext?: import("@blame/telemetry").Context,
) {
  return blameTelemetry.structuredLog(
    logSeverity(payload),
    logEventName(message),
    safeLogPayload(payload),
    activeContext,
  );
}

function logEventName(message: string) {
  return `blame.agent.${message.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

function logSeverity(payload: unknown) {
  const status = stringValue(asRecord(payload).status);
  return status === "failed" || status === "error" ? "error" : "info";
}
