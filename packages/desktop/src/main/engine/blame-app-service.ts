// The desktop's answer to the self-repair tools' `blameApp` service
// (`blame_inspect`, `blame_repair`): what only the main process knows of the
// app, its runtime VM and its own log, and the two repairs that act on it.
// A request is JSON; what it returns is bounded and its text went through
// the desktop log's redaction.

import type {
  BlameAppLog,
  BlameAppState,
} from "@blame/agent-runtime/engine-protocol";
import { liveLogErrors, readLiveLog } from "../live-log-reader.ts";
import { redactLogData } from "../desktop-log-redaction.ts";
import { grantedGithubTokens } from "../github-access/agent-github-access.ts";

const maximumLines = 300;
const runtimeTimeoutMs = 20_000;

export async function blameApp(input: unknown): Promise<unknown> {
  const request = record(input);
  switch (request.action) {
    case "state":
      return state();
    case "log":
      return log(request);
    case "restart_preview":
      return restartPreview(request);
    case "start_runtime":
      return startRuntime();
    default:
      throw new Error("Unknown request for the app.");
  }
}

function redact(line: string) {
  return String(redactLogData([line], grantedGithubTokens())[0]);
}

async function logPath() {
  const { liveLogPath } = await import("../desktop-live-log.ts");
  return liveLogPath();
}

async function log(request: Record<string, unknown>): Promise<BlameAppLog> {
  const lines = Math.min(
    Math.max(Math.trunc(Number(request.lines)) || 60, 1),
    maximumLines,
  );
  return readLiveLog(
    await logPath(),
    {
      lines,
      ...(typeof request.search === "string" && request.search
        ? { search: request.search }
        : {}),
    },
    redact,
  );
}

async function state(): Promise<BlameAppState> {
  const { app } = await import("electron");
  const [runtime, errors] = await Promise.all([
    runtimeState(),
    logPath().then((path) => liveLogErrors(path, redact)),
  ]);
  return {
    app: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    },
    ...(runtime ? { runtime } : {}),
    log: errors,
  };
}

async function runtimeState(): Promise<BlameAppState["runtime"]> {
  const { getRuntimeStatus } = await import("../runtime-manager.ts");
  try {
    const report = await Promise.race([
      getRuntimeStatus(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("no answer")),
          runtimeTimeoutMs,
        ).unref(),
      ),
    ]);
    return {
      status: report.status,
      ...(report.startRequired ? { startRequired: true } : {}),
      ...(report.updateRequired ? { updateRequired: true } : {}),
      issues: report.issues.slice(0, 8).map((issue) => ({
        name: issue.name,
        status: issue.status,
        ...(issue.action ? { action: issue.action } : {}),
      })),
    };
  } catch (error) {
    return {
      status: "unknown",
      issues: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// A story's local preview, stopped and started as one operation; a cloud or
// project-folder preview is not Blame's to restart from here.
async function restartPreview(request: Record<string, unknown>) {
  const worktree = typeof request.worktree === "string" ? request.worktree : "";
  if (!worktree) throw new Error("The preview is unknown.");
  if (request.workspaceMode && request.workspaceMode !== "local-container")
    throw new Error("Only a local preview restarts from here.");
  const { controlProjectPreview } = await import("../workspace-ipc.ts");
  await controlProjectPreview({ action: "restart", worktree });
  return { restarted: true };
}

// Boots the VM only when it is installed and stopped: no install, update or
// repair, and never a restart of a running one.
async function startRuntime() {
  const { ensureRuntimeReady, getRuntimeStatus } =
    await import("../runtime-manager.ts");
  const report = await getRuntimeStatus();
  if (report.status !== "ready") {
    if (!report.startRequired)
      throw new Error(
        "The runtime is not just stopped; only the person repairs it.",
      );
    await ensureRuntimeReady();
  }
  return state();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
