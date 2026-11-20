// GitHub's MCP server, for a session with read-only GitHub access. The
// desktop connects to it with the session's token, which never reaches this
// process: listing tools for any other session returns none. What the tools
// answer is masked by the tool set's guards (issues, CI logs and files can
// hold tokens).

import { toolOutputLimits } from "../../tool-output-limit.js";
import type { DesktopServices } from "../desktop-services.js";
import { defineTool, type ClientTool } from "../tool.js";
import { errorMessage, modelOutput } from "./output.js";

export const githubToolPrefix = "github__";

// Above the desktop's call timeout, so the agent reads its message.
const githubMcpAgentTimeoutMs = 75_000;

/** The session's GitHub tools: none without read-only access or when GitHub cannot be reached. */
export async function githubClientTools(
  services: Pick<DesktopServices, "githubMcpTools" | "githubMcpCall"> & {
    log?(message: string, payload?: Record<string, unknown>): void;
  },
  session: string,
): Promise<ClientTool<never>[]> {
  const { githubMcpCall: call, githubMcpTools: list } = services;
  if (!list || !call) return [];
  try {
    const descriptors = await list({ sessionId: session });
    return descriptors.map((descriptor) =>
      defineTool<Record<string, unknown>>({
        name: `${githubToolPrefix}${descriptor.name}`,
        description:
          descriptor.description?.trim() ||
          `Execute MCP tool "${descriptor.name}" from server "github".`,
        inputSchema: descriptor.inputSchema,
        effect: "read_only",
        source: { kind: "mcp", server: "github" },
        timeoutMs: githubMcpAgentTimeoutMs,
        run: async (input, { signal }) =>
          modelOutput(
            await call({
              arguments: input,
              sessionId: session,
              signal,
              toolName: descriptor.name,
            }),
            toolOutputLimits.githubMcp,
          ),
      }),
    );
  } catch (error) {
    services.log?.("GitHub MCP tools unavailable", {
      error: errorMessage(error),
    });
    return [];
  }
}
