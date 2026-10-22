import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  claudeCodeEnvironment,
  findClaudeCodeExecutable,
} from "./claude-code/claude-code-cli.js";
import type {
  OAuthCredentials,
  SubscriptionUsage,
  SubscriptionUsageWindow,
} from "./types.js";

const execFileAsync = promisify(execFile);

const codexUsageUrl = "https://chatgpt.com/backend-api/wham/usage";
/** A rate limit event this recent is as good as asking Claude Code again. */
const freshRateLimitMs = 2 * 60 * 1_000;

let latestClaudeCodeRateLimit:
  | { receivedAt: number; info: Record<string, unknown> }
  | undefined;

/** Claude Code reports the plan's windows with every model call. */
export function recordClaudeCodeRateLimit(info: unknown) {
  if (isRecord(info)) latestClaudeCodeRateLimit = { receivedAt: Date.now(), info };
}

/**
 * How much of a Claude plan is used. A recent event from a running
 * conversation is exact; otherwise Claude Code's `/usage` answers without a
 * model call.
 */
export async function readClaudeCodeUsage(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubscriptionUsage | null> {
  const latest = latestClaudeCodeRateLimit;
  if (latest && Date.now() - latest.receivedAt < freshRateLimitMs) {
    const windows = claudeCodeEventWindows(latest.info);
    if (windows.length) return usage("claude-code", windows, latest.receivedAt);
  }
  const childEnv = claudeCodeEnvironment(env);
  const executable = findClaudeCodeExecutable(childEnv);
  if (!executable) return null;
  const { stdout } = await execFileAsync(
    executable,
    ["--print", "/usage", "--output-format", "json", "--no-session-persistence"],
    { env: childEnv, timeout: 30_000 },
  );
  const result = (JSON.parse(stdout) as { result?: unknown }).result;
  const windows = typeof result === "string" ? parseClaudeCodeUsage(result) : [];
  return windows.length ? usage("claude-code", windows) : null;
}

export function claudeCodeEventWindows(
  info: Record<string, unknown>,
): SubscriptionUsageWindow[] {
  const windows = isRecord(info.unifiedWindows) ? info.unifiedWindows : {};
  return Object.entries(windows).flatMap(([id, value]) => {
    if (!isRecord(value) || typeof value.utilization !== "number") return [];
    return [
      {
        id,
        label: claudeWindowLabel(id),
        usedPercent: percent(value.utilization * 100),
        ...(typeof value.resetsAt === "number"
          ? { resetsAt: value.resetsAt * 1_000 }
          : {}),
      },
    ];
  });
}

/** Reads lines such as "Current week (all models): 15% used · resets Oct 27 at 9:59pm". */
export function parseClaudeCodeUsage(text: string): SubscriptionUsageWindow[] {
  const pattern =
    /^Current (session|week(?: \(([^)]+)\))?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets (.+))?$/gm;
  return [...text.matchAll(pattern)].map((match) => {
    const session = match[1] === "session";
    const scope = match[2];
    const id = session
      ? "five_hour"
      : !scope || scope === "all models"
        ? "seven_day"
        : `seven_day_${scope.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    return {
      id,
      label: session
        ? "5 hours"
        : !scope || scope === "all models"
          ? "Week"
          : `Week · ${scope.replace(/ only$/i, "")}`,
      usedPercent: percent(Number(match[3])),
      ...(match[4] ? { resetsLabel: match[4].trim() } : {}),
    };
  });
}

/** How much of a ChatGPT plan is used, from the endpoint the Codex CLI reads. */
export async function readCodexUsage(
  credentials: OAuthCredentials | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SubscriptionUsage | null> {
  if (!credentials?.access) return null;
  const accountId = credentials.accountId ?? codexAccountId(credentials.access);
  const response = await fetchImpl(codexUsageUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credentials.access}`,
      originator: "cline",
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`ChatGPT usage request failed (${response.status}).`);
  return codexUsage(await response.json());
}

export function codexUsage(body: unknown): SubscriptionUsage | null {
  if (!isRecord(body) || !isRecord(body.rate_limit)) return null;
  const limits = body.rate_limit;
  const windows = (["primary_window", "secondary_window"] as const).flatMap(
    (key) => {
      const window = limits[key];
      if (!isRecord(window) || typeof window.used_percent !== "number") return [];
      const seconds = Number(window.limit_window_seconds);
      return [
        {
          id: key === "primary_window" ? "primary" : "secondary",
          label: windowLabel(seconds),
          usedPercent: percent(window.used_percent),
          ...(Number.isFinite(seconds) && seconds > 0
            ? { windowMinutes: Math.round(seconds / 60) }
            : {}),
          ...(typeof window.reset_at === "number"
            ? { resetsAt: window.reset_at * 1_000 }
            : {}),
        },
      ];
    },
  );
  if (!windows.length) return null;
  return {
    ...usage("openai-codex", windows),
    ...(typeof body.plan_type === "string" ? { planType: body.plan_type } : {}),
  };
}

function usage(
  providerId: string,
  windows: SubscriptionUsageWindow[],
  checkedAt = Date.now(),
): SubscriptionUsage {
  return { providerId, windows, checkedAt };
}

function claudeWindowLabel(id: string) {
  if (id === "five_hour") return "5 hours";
  if (id === "seven_day") return "Week";
  const scope = /^seven_day_(.+)$/.exec(id)?.[1];
  return scope ? `Week · ${scope.replace(/_/g, " ")}` : id.replace(/_/g, " ");
}

function windowLabel(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Limit";
  const hours = seconds / 3_600;
  if (hours >= 24 * 6) return "Week";
  if (hours >= 24) return `${Math.round(hours / 24)} days`;
  return `${Math.round(hours)} hours`;
}

function codexAccountId(token: string) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    return isRecord(auth) && typeof auth.chatgpt_account_id === "string"
      ? auth.chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
}

function percent(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
