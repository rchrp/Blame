// The text the self-repair tools hand to the model: bounded, with secrets
// masked, whatever the source. Logs, READMEs and skill files are evidence
// the model reads, never instructions, so every tool passes its answer
// through here once, as the last step.

import { redactSecurityValue } from "../../security-secret-redaction.js";
import type { ToolOutput } from "../tool.js";

const longestLine = 300;

/** The answer as JSON the model reads, masked. */
export function blameOutput(value: unknown, ok = true): ToolOutput {
  return { ...(ok ? {} : { ok: false }), json: redactSecurityValue(value) };
}

/** A failure the model reads: what went wrong and what to try. */
export function blameFailure(message: string, next?: string): ToolOutput {
  return blameOutput(
    { outcome: "failed", error: message, ...(next ? { next } : {}) },
    false,
  );
}

/**
 * The last lines of a text, the ones holding `search` when given, each cut
 * to a readable length. Returns the lines and how many matched.
 */
export function tailLines(
  text: string,
  count: number,
  search?: string,
): { lines: string[]; total: number } {
  const needle = search?.toLowerCase();
  const all = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .filter((line) => !needle || line.toLowerCase().includes(needle));
  return {
    total: all.length,
    lines: all
      .slice(-count)
      .map((line) =>
        line.length > longestLine ? `${line.slice(0, longestLine)}…` : line,
      ),
  };
}

/** A promise that gives up: an area that hangs must not hold the overview. */
export async function settle<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return {
      ok: true,
      value: await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer after ${ms / 1000} s`)),
            ms,
          );
        }),
      ]),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The text of whatever a log service answered. */
export function logText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const value = result as Record<string, unknown>;
  const parts = ["setupLog", "stdout", "stderr", "output", "message"]
    .map((key) => value[key])
    .filter((part): part is string => typeof part === "string" && !!part);
  return parts.length ? parts.join("\n") : JSON.stringify(result);
}
