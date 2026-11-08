import type { LogMessage } from "electron-log";
import { redactSecuritySecrets } from "@blame/agent-runtime/security-secret-redaction";
import { grantedGithubTokens } from "./github-access/agent-github-access.ts";

// Desktop logs (electron-log's file and console) never carry a GitHub token:
// the tokens granted to agent sessions, whatever their shape, and every
// value that looks like a credential (ghp_, gho_, github_pat_, GH_TOKEN=...).

const githubTokenVariables = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

export function registerDesktopLogRedaction(logger: {
  hooks: Array<(message: LogMessage) => LogMessage | false>;
}) {
  logger.hooks.push((message) => ({
    ...message,
    data: redactLogData(message.data, grantedGithubTokens()),
  }));
}

export function redactLogData(data: unknown[], tokens: string[]) {
  return data.map((value) => redactLogValue(value, tokens, new WeakSet()));
}

function redactLogValue(
  value: unknown,
  tokens: string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return redactText(value, tokens);
  if (!value || typeof value !== "object") return value;
  // The original would be logged unredacted through the cycle.
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) {
    const redacted = new Error(redactText(value.message, tokens));
    redacted.name = value.name;
    redacted.stack = value.stack && redactText(value.stack, tokens);
    return redacted;
  }
  if (Array.isArray(value))
    return value.map((item) => redactLogValue(item, tokens, seen));
  // Class instances (Buffers, Maps, ...) keep their own formatting.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      githubTokenVariables.has(key.toUpperCase()) && typeof item === "string" && item
        ? `<REDACTED_SECRET:${key}>`
        : redactLogValue(item, tokens, seen),
    ]),
  );
}

function redactText(text: string, tokens: string[]) {
  const withoutGranted = tokens.reduce(
    (current, token) => current.replaceAll(token, "<REDACTED_SECRET:GH_TOKEN>"),
    text,
  );
  return redactSecuritySecrets(withoutGranted);
}
