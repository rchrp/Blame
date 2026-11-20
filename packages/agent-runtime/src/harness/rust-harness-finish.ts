import type { AgentToolContext } from "@cline/sdk";
import type { FinishTaskImage, LightToolResult } from "./light-contracts.js";
import type { LocalFinishOptions } from "./light-finish-service.js";
import { RustHarnessProcess } from "./rust-harness-adapter.js";

// Conformance adapter for finish_task: the TypeScript finish service's
// interface, served by the Rust harness's finish_task request.
// rust-harness-hooks.ts substitutes it for ./light-finish-service.js in the
// tests, their fixture, light-executor and finish-task (rust mode only).

export { unverifiedReply, type FinalReply, type LocalFinishOptions } from "./light-finish-service.js";

const harness = new RustHarnessProcess();

type LocalFinishTaskInput = {
  context: AgentToolContext;
  input: unknown;
  taskContract?: LocalFinishOptions["taskContract"];
  workspaceRoot: string;
};

type FinishResult = LightToolResult<unknown> & {
  data?: { notification?: unknown; summary?: string; validationActivities?: unknown[] };
  validationActivities?: unknown[];
};

function reason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
}

/** In process, a cancelled finish fails with the signal's reason; over the protocol a cancel carries none. */
async function finishRequest(body: Record<string, unknown>, context?: Partial<AgentToolContext>) {
  const toolContext = context?.toolCallId ? { toolCallId: context.toolCallId } : {};
  const signal = context?.signal;
  const result = await harness.send("request", { tool: "finish_task", toolContext, ...body }, signal) as FinishResult;
  if (signal?.aborted && result.status !== "ok") return { ...result, message: reason(signal).message };
  return result;
}

export async function executeLocalFinishTask(input: LocalFinishTaskInput): Promise<LightToolResult<unknown>> {
  return finishRequest({ input: input.input, taskContract: input.taskContract, workspaceRoot: input.workspaceRoot }, input.context);
}

export class LightFinishService {
  private readonly options: LocalFinishOptions;

  constructor(options: LocalFinishOptions) {
    this.options = options;
  }

  async finish(summary: string, context: AgentToolContext, images: FinishTaskImage[] = []) {
    const result = await finishRequest({
      input: { summary, finishImages: images, reportActivities: true },
      taskContract: { ...this.options.taskContract, session_id: this.options.conversationId },
      workspaceRoot: this.options.workspaceRoot,
    }, context);
    const activities = result.status === "ok" ? result.data?.validationActivities : result.validationActivities;
    for (const activity of activities ?? []) await this.options.onValidationActivity?.(activity as never);
    if (result.status !== "ok") throw context?.signal?.aborted ? reason(context.signal) : new Error(result.message);
    if (result.data?.notification) await this.options.onComplete?.(result.data.notification as never);
    return result.data?.summary ?? summary;
  }
}
