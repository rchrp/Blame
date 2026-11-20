import type { CompletionDecision } from "@blame/harness-core";
import type { LightTaskContract, LightToolResult } from "../light-contracts.js";
import { HarnessProcess } from "./harness.js";

// The finish service's interface the behavioural tests drive, served by
// blame-harness's finish_task request: validation activities are replayed
// to their listener, a cancelled finish fails with the signal's reason.

type AgentToolContext = { signal?: AbortSignal; toolCallId?: string; [key: string]: unknown };
export type FinishTaskImage = { caption: string; id: string };
/** finish_task's notification, as the harness answers it. */
export type LightCompletionNotification = {
  completion: CompletionDecision;
  images?: FinishTaskImage[];
  memory?: { validationTaskId?: string; files?: Array<{ hash: string; path: string }>; [key: string]: unknown };
  submission_outcome: "accepted" | "blocked";
  summary: string;
  verified: boolean;
  validationReport?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
};
/** A validation that finish ran or reused, as reported to its listener. */
export type LightValidationActivity = { input: any; output?: unknown; phase: "finished" | "started"; toolCallId: string }; // eslint-disable-line @typescript-eslint/no-explicit-any

export type LocalFinishOptions = {
  conversationId: string;
  onComplete?(notification: LightCompletionNotification): Promise<void> | void;
  onValidationActivity?(activity: LightValidationActivity): Promise<void> | void;
  taskContract?: LightTaskContract;
  workspaceRoot: string;
};

const harness = new HarnessProcess();

type LocalFinishTaskInput = {
  context: AgentToolContext;
  input: unknown;
  taskContract?: LightTaskContract;
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

/**
 * finish_task as a tool (`createFinishTaskTool`): the summary back, the
 * completion and validation activities to their listeners. `executor` named
 * where the TypeScript harness ran elsewhere; blame-harness is the one.
 */
export function createFinishTaskTool(options: LocalFinishOptions & { executor?: unknown }) {
  const service = new LightFinishService(options);
  return {
    name: "finish_task",
    execute: (input: { summary: string; images?: FinishTaskImage[] }, context: AgentToolContext) =>
      service.finish(input.summary, context, input.images ?? []),
  };
}
