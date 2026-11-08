import type { AgentPlugin } from "@cline/sdk";
import { redactSecurityValue } from "./security-secret-redaction.js";

// Cline gives this result policy to the tools it builds from MCP servers
// (createMcpTools: cline_mcp_settings.json, agent plugins, Blame's preview
// DevTools) and from Composio. Their results come from outside Blame's
// harness, whose own tools mask their responses themselves.
const externalToolResultPolicy = "cache-oversized";

// The parts of Cline's AgentAfterToolContext and AgentToolResult this hook uses.
type ToolResult = {
  isError?: boolean;
  metadata?: Record<string, unknown>;
  output: unknown;
};
type AfterToolContext = {
  result: ToolResult;
  tool: { resultPolicy?: string };
};

/**
 * Masks the secrets in the text and JSON of external tool results before
 * they reach the model and the transcript. Images and binary parts are kept.
 */
export function mcpResultRedactionExtension(): AgentPlugin {
  return {
    name: "blame-mcp-result-redaction",
    manifest: { capabilities: ["hooks"] },
    hooks: {
      afterTool({
        tool,
        result,
      }: AfterToolContext): { result: ToolResult } | undefined {
        if (tool.resultPolicy !== externalToolResultPolicy) return undefined;
        return {
          result: { ...result, output: redactSecurityValue(result.output) },
        };
      },
    },
  };
}
