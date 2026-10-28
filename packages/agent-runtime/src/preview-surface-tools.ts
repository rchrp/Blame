import type { CoreSessionConfig } from "@cline/sdk";
import type {
  PreviewRuntimeContext,
  PreviewToolRuntimeOptions,
} from "./preview-harness-tools.js";
import {
  previewToolModelOutput,
  recordSessionScreenshots,
} from "./preview-screenshots.js";

export type PreviewSurfaceInfo = {
  type: "terminal" | "display" | "device" | "host-window";
  serviceId?: string;
  targetId?: string;
};
type Tool = NonNullable<CoreSessionConfig["extraTools"]>[number];
const actions = {
  terminal: ["read", "type", "key", "wait_for", "restart"],
  display: ["screenshot", "windows", "click", "type", "key", "scroll", "drag"],
  device: [
    "status",
    "screenshot",
    "describe_ui",
    "tap",
    "swipe",
    "type",
    "key",
    "button",
    "open_url",
    "build_and_run",
    "logs",
  ],
};

export function previewSurfaceTool(
  options: PreviewToolRuntimeOptions,
  preview: PreviewRuntimeContext,
  info: PreviewSurfaceInfo,
): Tool | undefined {
  if (info.type === "host-window" || !options.previewSurfaceCall) return;
  const type = info.type;
  return {
    name: `preview_${type}`,
    description:
      type === "terminal"
        ? "Read and interact with the program terminal. The user sees this same terminal; do not clear it without reason. read returns at most 200 lines, the cursor and exit code. type writes text; submit adds Enter. wait_for uses a bounded regular expression (200 characters, up to 60 seconds). Restart runs the program again."
        : type === "device"
          ? "Inspect and interact with this story's device. Call describe_ui before tapping; coordinates are in points. Build errors refer to worktree files. Take a screenshot to check changes after build_and_run."
          : "Inspect and interact with the app's screen. Use windows and a screenshot before clicking; coordinates are pixels in the configured screen. The user sees your actions.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions[type] },
        text: { type: "string", maxLength: 64000 },
        submit: { type: "boolean" },
        key: { type: "string", maxLength: 100 },
        keys: { type: "string", maxLength: 100 },
        pattern: { type: "string", maxLength: 200 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 60000 },
        x: { type: "number", minimum: 0, maximum: 3840 },
        y: { type: "number", minimum: 0, maximum: 3840 },
        toX: { type: "number", minimum: 0, maximum: 3840 },
        toY: { type: "number", minimum: 0, maximum: 3840 },
        button: { type: "string", maxLength: 30 },
        double: { type: "boolean" },
        deltaY: { type: "integer", minimum: -1000, maximum: 1000 },
        url: { type: "string", maxLength: 2048 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (
      input: unknown,
      context: Parameters<Tool["execute"]>[1],
    ) => {
      const result = await options.previewSurfaceCall!({
        ...preview,
        surface: info,
        arguments: boundedSurfaceArguments(input),
        signal: context.signal,
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
      });
      recordSessionScreenshots(context.sessionId, result);
      return previewToolModelOutput(result) as never;
    },
  };
}

export function boundedSurfaceArguments(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Surface arguments must be an object.");
  const input = value as Record<string, unknown>;
  if (JSON.stringify(input).length > 70000)
    throw new Error("Surface arguments are too large.");
  if (
    input.pattern !== undefined &&
    (typeof input.pattern !== "string" || input.pattern.length > 200)
  )
    throw new Error("Use a pattern of at most 200 characters.");
  if (
    input.timeoutMs !== undefined &&
    (!Number.isInteger(input.timeoutMs) ||
      Number(input.timeoutMs) < 1 ||
      Number(input.timeoutMs) > 60000)
  )
    throw new Error("Wait at most 60 seconds.");
  return input;
}
