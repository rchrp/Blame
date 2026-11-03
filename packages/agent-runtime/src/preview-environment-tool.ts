import type { CoreSessionConfig } from "@cline/sdk";
import type { PreviewEnvironmentKeyStatus } from "./preview-environment-types.js";
import type { PreviewRuntimeContext } from "./preview-harness-tools.js";

// Lets the development agent see which environment variables the story's
// preview has, by name and status only, and ask the person for one it
// needs. Values never reach the agent: the person sets them in the
// Variables tab of the preview, where the request shows.

export type PreviewEnvironmentToolInput = PreviewRuntimeContext &
  (
    | { action: "list" }
    | { action: "request"; key: string; reason: string; serviceId?: string }
  );

export type PreviewEnvironmentToolResult =
  | { action: "list"; variables: PreviewEnvironmentKeyStatus[] }
  | { action: "request"; requested: string };

export type PreviewEnvironmentToolOptions = {
  previewEnvironment?(
    input: PreviewEnvironmentToolInput,
  ): Promise<PreviewEnvironmentToolResult>;
};

type AgentTool = NonNullable<CoreSessionConfig["extraTools"]>[number];

const keyPattern = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export function previewEnvironmentTool(
  options: PreviewEnvironmentToolOptions,
  preview?: PreviewRuntimeContext,
): AgentTool | undefined {
  if (!options.previewEnvironment || !preview) return undefined;
  return {
    name: "preview_environment",
    description:
      "List the environment variables of this story's preview by name and status (set, missing or placeholder), never their values. When the story needs a variable only the person can provide, such as an API key, request it: the request shows in the preview's Variables tab, and the value reaches the preview at its next start. Never ask for values in your reply and never write secrets into files.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "request"],
          description: "list the variables, or request one from the person.",
        },
        key: {
          type: "string",
          description:
            "For request: the variable name, such as STRIPE_SECRET_KEY.",
        },
        reason: {
          type: "string",
          description:
            "For request: one sentence on what the story needs it for.",
        },
        serviceId: {
          type: "string",
          description:
            "For request: the preview service that reads it, if one.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: (input: unknown) =>
      executePreviewEnvironment(options, preview, input),
  };
}

async function executePreviewEnvironment(
  options: PreviewEnvironmentToolOptions,
  preview: PreviewRuntimeContext,
  input: unknown,
) {
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  try {
    if (record.action === "request") {
      const key = typeof record.key === "string" ? record.key.trim() : "";
      const reason =
        typeof record.reason === "string" ? record.reason.trim() : "";
      if (!keyPattern.test(key) || !reason)
        return failure("A request needs a variable name and a reason.");
      return await options.previewEnvironment!({
        ...preview,
        action: "request",
        key,
        reason,
        ...(typeof record.serviceId === "string" && record.serviceId
          ? { serviceId: record.serviceId }
          : {}),
      });
    }
    return await options.previewEnvironment!({ ...preview, action: "list" });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

function failure(message: string) {
  return { outcome: "failed", isError: true, output: { error: message } };
}
