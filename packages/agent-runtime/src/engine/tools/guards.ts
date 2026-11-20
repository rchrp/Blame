// The guards every client tool call goes through (`ToolSet` options), the one
// place that keeps secrets away from the model:
// - a call that names a developer env file (`.env`, `.env.local`) is refused:
//   their values are secrets, previews get them from Blame, and the agent
//   reads `.env.example` or `preview_environment` for the names;
// - what an MCP server answers (GitHub, the preview's DevTools, the user's own
//   servers) is masked before the model and the transcript see it. Blame's
//   own tools mask their answers themselves.

import { redactSecurityValue } from "../../security-secret-redaction.js";
import type { ToolGuard, ToolOutput } from "../tool.js";

const templateSuffixes = [".example", ".sample", ".template", ".dist"];

/** A developer env file, such as `.env` or `.env.local`, not an example. */
export function developerEnvFile(path: string) {
  const name = path.replace(/\\/g, "/").split("/").at(-1) ?? "";
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return !templateSuffixes.some((suffix) => name.endsWith(suffix));
}

/** The paths a tool input names, under the usual path keys at any depth. */
export function inputPaths(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(inputPaths);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, entry]) =>
      /^(?:path|paths|file|files|file_path|filePath|requests|uri)$/.test(key)
        ? inputPaths(entry)
        : Array.isArray(entry) || (entry && typeof entry === "object")
          ? inputPaths(entry)
          : [],
  );
}

/** Why a call that reads these inputs is refused, if it is. */
export function envFileRefusal(input: unknown): string | undefined {
  const blocked = inputPaths(input)
    .map((path) => path.replace(/^file:\/\//, ""))
    .filter(developerEnvFile);
  if (!blocked.length) return undefined;
  return `Blame keeps the values of ${blocked.join(", ")} out of this analysis. Read .env.example for the expected keys; previews get the developer's values from Blame.`;
}

/**
 * Masks the secrets in the text and JSON of an external tool's answer.
 * Images and binary parts are kept as they are.
 */
export function redactExternalResult<T>(result: T): T {
  return redactSecurityValue(result);
}

export const envFileGuard: ToolGuard = {
  before: ({ input }) => envFileRefusal(input),
};

export const mcpResultRedaction: ToolGuard = {
  after: ({ tool }, output): ToolOutput =>
    tool.source?.kind === "mcp" ? redactExternalResult(output) : output,
};

/** The guards of the engine host's tool set, in the order they run. */
export const clientToolGuards: ToolGuard[] = [envFileGuard, mcpResultRedaction];
