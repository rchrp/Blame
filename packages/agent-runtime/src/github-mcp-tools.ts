import type { CoreSessionConfig } from "@cline/sdk";
import { createMcpTools } from "@cline/sdk";
import { redactSecurityValue } from "./security-secret-redaction.js";
import { limitToolText, toolOutputLimits } from "./tool-output-limit.js";

type AgentTool = NonNullable<CoreSessionConfig["extraTools"]>[number];
type ToolContext = Parameters<AgentTool["execute"]>[1];

export type GithubMcpToolDescriptor = {
  description?: string;
  inputSchema: Record<string, unknown>;
  name: string;
};

// GitHub's MCP server for a session with read-only GitHub access. The desktop
// connects to it with the session's token, which never reaches this process:
// listing tools for any other session returns none.
export type GithubMcpToolOptions = {
  githubMcpTools?(input: {
    sessionId: string;
  }): Promise<readonly GithubMcpToolDescriptor[]>;
  githubMcpCall?(input: {
    arguments?: Record<string, unknown>;
    sessionId: string;
    signal?: AbortSignal;
    toolName: string;
  }): Promise<unknown>;
};

type GithubToolsLogger = {
  log(message: string, payload?: Record<string, unknown>): void;
};

// Above the desktop's call timeout, so the agent reads its message.
const githubMcpAgentTimeoutMs = 75_000;

/**
 * The session's GitHub tools, created in memory with createMcpTools: they are
 * never written to cline_mcp_settings.json. None when the session has no
 * read-only GitHub access or GitHub cannot be reached.
 */
export async function githubMcpTools(
  options: GithubMcpToolOptions,
  sessionId: string,
  logger: GithubToolsLogger,
): Promise<AgentTool[]> {
  const { githubMcpCall, githubMcpTools: listTools } = options;
  if (!listTools || !githubMcpCall) return [];
  try {
    return await createMcpTools({
      maxRetries: 0,
      nameTransform: ({ toolName }: { toolName: string }) =>
        `github__${toolName}`,
      provider: {
        listTools: () => listTools({ sessionId }),
        async callTool(request: {
          arguments?: Record<string, unknown>;
          context?: ToolContext;
          toolName: string;
        }) {
          const result = await githubMcpCall({
            arguments: request.arguments,
            sessionId,
            signal: request.context?.signal,
            toolName: request.toolName,
          });
          return limitToolText(redactedResult(result), toolOutputLimits.githubMcp);
        },
      },
      retryable: false,
      serverName: "github",
      timeoutMs: githubMcpAgentTimeoutMs,
    });
  } catch (error) {
    logger.log("GitHub MCP tools unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// Issues, CI logs and files can hold tokens: their text is redacted before
// it reaches the model and the transcript. Images and other binary parts
// are kept as they are.
function redactedResult(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return redactSecurityValue(result);
  const { content, ...rest } = result as Record<string, unknown>;
  if (!Array.isArray(content)) return redactSecurityValue(result);
  return {
    ...redactSecurityValue(rest),
    content: content.map((part) =>
      binaryPart(part) ? part : redactSecurityValue(part),
    ),
  };
}

function binaryPart(part: unknown) {
  const type =
    part && typeof part === "object" ? (part as { type?: unknown }).type : undefined;
  return type === "image" || type === "audio";
}
