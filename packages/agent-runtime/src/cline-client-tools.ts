// Client tools (engine/tools) given to the conversations that still run on
// Cline: each Cline tool is this thin adapter over the one definition, and
// goes with the Cline path. Images stay native image blocks, as Cline sends
// them to the model; an MCP tool keeps Cline's external result policy, so
// the result redaction hook masks its answer.

import { randomUUID } from "node:crypto";
import type { AgentTool } from "./cline-initialization.js";
import type { ClientTool, ToolOutput } from "./engine/tool.js";

type ClineContext = Parameters<AgentTool["execute"]>[1] & {
  conversationId?: string;
  runId?: string;
  sessionId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
};

export function clineTool(tool: ClientTool<never>): AgentTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.timeoutMs ? { timeoutMs: tool.timeoutMs } : {}),
    ...(tool.source?.kind === "mcp" ? { resultPolicy: "cache-oversized" } : {}),
    retryable: false,
    maxRetries: 0,
    async execute(input: unknown, context: ClineContext) {
      const session = context?.sessionId ?? context?.conversationId ?? "";
      const output = await tool.run(
        (input && typeof input === "object" ? input : {}) as never,
        {
          session,
          turn: context?.runId ?? session,
          call: context?.toolCallId ?? randomUUID(),
          signal: context?.signal ?? new AbortController().signal,
          progress: () => undefined,
        },
      );
      return clineOutput(output) as never;
    },
  } as AgentTool;
}

export function clineTools(tools: readonly (ClientTool<never> | undefined)[]) {
  return tools
    .filter((tool): tool is ClientTool<never> => Boolean(tool))
    .map(clineTool);
}

/** What Cline's tool returns for this output: text, an object, or blocks. */
export function clineOutput(output: ToolOutput): unknown {
  if (typeof output === "string") return output;
  if ("json" in output) return output.json;
  if (output.ok === false)
    throw new Error(
      output.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n"),
    );
  return output.content.flatMap((block): unknown[] => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if ("blob" in block) return [];
    return [
      {
        type: "image",
        data: block.data,
        mediaType: block.mediaType,
        ...(block.screenshot ? { blameScreenshot: block.screenshot } : {}),
      },
    ];
  });
}
