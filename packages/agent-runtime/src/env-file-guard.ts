import type { AgentPlugin } from "@cline/sdk";
import { envFileRefusal } from "./engine/tools/guards.js";

// The agents that analyze or repair a project's preview setup never read the
// developer's env files: their values are secrets, and the setup only needs
// key names, which `.env.example` and the scan give. Blame passes the
// developer's values to previews itself, outside the agents. The rule itself
// lives with the engine's tool guards (engine/tools/guards.ts); this is its
// hook for the Cline agents that still read files with read_files.

export { developerEnvFile } from "./engine/tools/guards.js";

export function envFileGuardExtension(): AgentPlugin {
  return {
    name: "blame-env-file-guard",
    manifest: { capabilities: ["hooks"] },
    hooks: {
      beforeTool({ tool, input }: { tool: { name: string }; input: unknown }) {
        if (tool.name !== "read_files") return undefined;
        const reason = envFileRefusal(input);
        return reason ? { skip: true, reason } : undefined;
      },
    },
  } as AgentPlugin;
}
