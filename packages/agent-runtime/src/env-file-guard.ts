import type { AgentPlugin } from "@cline/sdk";

// The agents that analyze or repair a project's preview setup never read the
// developer's env files: their values are secrets, and the setup only needs
// key names, which `.env.example` and the scan give. Blame passes the
// developer's values to previews itself, outside the agents.

const templateSuffixes = [".example", ".sample", ".template", ".dist"];

/** A developer env file, such as `.env` or `.env.local`, not an example. */
export function developerEnvFile(path: string) {
  const name = path.replace(/\\/g, "/").split("/").at(-1) ?? "";
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return !templateSuffixes.some((suffix) => name.endsWith(suffix));
}

function inputPaths(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(inputPaths);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, entry]) =>
      /^(?:path|paths|file|files|file_path|filePath|requests)$/.test(key)
        ? inputPaths(entry)
        : Array.isArray(entry) || (entry && typeof entry === "object")
          ? inputPaths(entry)
          : [],
  );
}

export function envFileGuardExtension(): AgentPlugin {
  return {
    name: "blame-env-file-guard",
    manifest: { capabilities: ["hooks"] },
    hooks: {
      beforeTool({ tool, input }: { tool: { name: string }; input: unknown }) {
        if (tool.name !== "read_files") return undefined;
        const blocked = inputPaths(input).filter(developerEnvFile);
        if (!blocked.length) return undefined;
        return {
          skip: true,
          reason: `Blame keeps the values of ${blocked.join(", ")} out of this analysis. Read .env.example for the expected keys; previews get the developer's values from Blame.`,
        };
      },
    },
  } as AgentPlugin;
}
