import type { LightTaskContract } from "../light-contracts.js";
import { HarnessProcess, unit } from "./harness.js";

// The model-facing tools the behavioural tests call, as the engine offers
// them: described by blame-harness and run with its `call` (input repair,
// validation, redaction, the result envelope), which answers what the
// model reads.

/** `parseLeniently`: JSON sent as strings repaired as the harness repairs a call's input. */
export function parseLeniently(schema: { name: string }, value: unknown) {
  return unitParse(schema.name, value);
}

function unitParse(name: string, value: unknown) {
  const result = unit("parseInput", name, value, true) as { success: boolean; data?: unknown; message?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result.success ? { success: true as const, data: result.data as any } : { success: false as const, data: undefined, error: { message: result.message ?? "" } };
}

export type HarnessTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  execute(input: unknown, context?: Record<string, unknown>): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export function lightSemanticHarnessTools(
  workspaceRoot: string,
  options: {
    taskContract?: LightTaskContract;
    commandCredentials?: () => Promise<unknown>;
    responseStyle?: string;
    /** In the TypeScript harness, a workspace elsewhere behind in-process tools; blame-harness is both. */
    executor?: unknown;
  } = {},
): HarnessTool[] {
  const harness = new HarnessProcess();
  const taskContract = options.taskContract;
  const described = unit("describeTools", { ...(taskContract ? { taskContract } : {}), ...(options.responseStyle ? { responseStyle: options.responseStyle } : {}) }) as Array<{ name: string; description: string; inputSchema: unknown }>;
  return described
    .filter(({ name }) => name !== "finish_task")
    .map((tool) => ({
      ...tool,
      async execute(input: unknown, context: Record<string, unknown> = {}) {
        const signal = context.signal as AbortSignal | undefined;
        const credentials = tool.name === "run_task" && options.commandCredentials
          ? await options.commandCredentials().catch(() => ({}))
          : undefined;
        const { signal: _, ...rest } = context;
        const presented = await harness.send("call", {
          tool: tool.name, input, workspaceRoot, taskContract, toolContext: JSON.parse(JSON.stringify(rest)),
          ...(credentials ? { commandCredentials: credentials } : {}),
        // The harness ends a cancelled call with an error (the engine's to
        // report); the in-process tool answered it blocked with the reason.
        }, signal).catch((error: unknown) => {
          if (signal?.aborted) return { content: { status: "blocked", category: "input", message: reason(signal) } };
          throw error;
        }) as { content: unknown };
        return modelValue(presented.content);
      },
    }));
}

function reason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
}

/**
 * What the model reads, as the value the tool returned: a JSON result the
 * engine sends as text is parsed back (the TypeScript tools returned the
 * object, which the agent loop serialized).
 */
function modelValue(content: unknown) {
  if (typeof content !== "string") return content;
  try {
    const value = JSON.parse(content) as unknown;
    return value && typeof value === "object" ? value : content;
  } catch {
    return content;
  }
}

/** finish_task's description for a response style, as the harness describes it. */
export function lightCompletionDescription(responseStyle?: string) {
  const tools = unit("describeTools", responseStyle ? { responseStyle } : {}) as Array<{ name: string; description: string }>;
  return tools.find(({ name }) => name === "finish_task")!.description;
}
