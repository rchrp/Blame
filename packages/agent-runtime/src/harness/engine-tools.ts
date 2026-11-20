import type { AgentTool, AgentToolContext } from "@cline/sdk";
import type { ResponseStyle } from "../personalization.js";
import { createFinishTaskTool } from "./finish-task.js";
import { lightCompletionToolName } from "./light-completion.js";
import type { LightTaskContract, LightToolResult } from "./light-contracts.js";
import type {
  LightWorkspaceExecutionRequest,
  LightWorkspaceExecutor,
} from "./light-executor.js";
import { lightSemanticHarnessTools } from "./light-tools.js";

// What the Rust engine needs to offer and run the harness tools itself: the
// runner describes them and presents their results exactly as the in-process
// Cline tools do, so the model reads the same bytes on both paths.

/** What a call can change, in the engine's vocabulary (`ToolEffect`). */
export type EngineToolEffect = "read_only" | "workspace_write" | "command";

export type EngineToolDescription = {
  name: string;
  description: string;
  /** JSON Schema of the input, as Cline hands it to the providers. */
  inputSchema: unknown;
  effect: EngineToolEffect;
  /** The turn ends when this call succeeds. */
  endsTurn: boolean;
};

export type EngineDescribeRequest = {
  responseStyle?: ResponseStyle;
  taskContract?: LightTaskContract;
};

/**
 * A result in its model-facing form: a string, or the parts of
 * encodeToolResult (text parts, then images as `{type: "image", data,
 * mediaType}`). `ok` is false when the model reads a refusal or a failure.
 */
export type EnginePresentedResult = { ok: boolean; content: string | unknown[] };

const effects: Record<string, EngineToolEffect> = {
  search_code: "read_only",
  read_code: "read_only",
  edit_code: "workspace_write",
  run_task: "command",
  // It may run the session's required checks again before it accepts.
  finish_task: "command",
};

function engineTools(
  workspaceRoot: string,
  executor: LightWorkspaceExecutor,
  taskContract?: LightTaskContract,
  responseStyle?: ResponseStyle,
): AgentTool[] {
  return [
    ...lightSemanticHarnessTools(workspaceRoot, { executor, taskContract }),
    createFinishTaskTool({
      conversationId: taskContract?.session_id ?? "unscoped-session",
      executor,
      responseStyle: responseStyle ? () => responseStyle : undefined,
      taskContract,
      workspaceRoot,
    }),
  ];
}

export function describeEngineTools(request: EngineDescribeRequest): EngineToolDescription[] {
  const nothing: LightWorkspaceExecutor = () =>
    Promise.reject(new Error("Describing the harness tools runs nothing."));
  // The descriptions do not depend on the workspace, only on the contract.
  return engineTools("/", nothing, request.taskContract, request.responseStyle).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    effect: effects[tool.name] ?? "command",
    endsTurn: tool.name === lightCompletionToolName,
  }));
}

/**
 * Runs one model call through the same tool wrapper as an in-process
 * session (input repair, validation, redaction, encodeToolResult). The raw
 * result of the workspace is also returned, so the runner can tell a call
 * that left a managed run going.
 */
export async function presentEngineToolCall(
  execute: LightWorkspaceExecutor,
  request: LightWorkspaceExecutionRequest,
  signal: AbortSignal,
): Promise<{ presented: EnginePresentedResult; raw?: LightToolResult<unknown> }> {
  let raw: LightToolResult<unknown> | undefined;
  const executor: LightWorkspaceExecutor = async (inner, innerSignal) => {
    raw = await execute(inner, innerSignal);
    return raw;
  };
  const tool = engineTools(request.workspaceRoot, executor, request.taskContract).find(
    (candidate) => candidate.name === request.tool,
  );
  if (!tool)
    return { presented: { ok: false, content: `There is no harness tool named ${request.tool}.` } };
  const context = { ...request.toolContext, signal } as AgentToolContext;
  try {
    const output = await tool.execute(request.input, context);
    signal.throwIfAborted();
    // finish_task returns the accepted summary and throws when it refuses.
    const ok = tool.name === lightCompletionToolName || raw?.status === "ok";
    const content = typeof output === "string" || Array.isArray(output) ? output : JSON.stringify(output);
    return { presented: { ok, content }, raw };
  } catch (error) {
    if (signal.aborted) throw error;
    return { presented: { ok: false, content: error instanceof Error ? error.message : String(error) }, raw };
  }
}
