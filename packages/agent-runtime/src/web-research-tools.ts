import type { AgentToolContext } from "@cline/sdk";
import type { AgentTool } from "./cline-initialization.js";
import type { ApiConnection } from "./types.js";
import type { RenderWebPage } from "./web-research-types.js";
import { webResearchCalls } from "./web-research-calls.js";

export { webResearchGuidance } from "./web-research-calls.js";

// The web research tools as the Cline runtime offers them; the engine host
// offers the same calls as client tools (engine/tools/web-research.ts).
export function webResearchTools(
  connection: ApiConnection,
  render?: RenderWebPage,
): AgentTool[] {
  return webResearchCalls.map((call) => ({
    timeoutMs: call.timeoutMs,
    name: call.name,
    description: call.description,
    inputSchema: call.inputSchema,
    execute: (input: unknown, context: AgentToolContext) =>
      call.run(input, { connection, render, signal: context.signal }),
  }));
}
