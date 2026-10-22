import type { AgentToolContext } from "@cline/sdk";
import {
  createLightCompletionTool,
  type LightCompletionNotification,
  type LightValidationActivity,
} from "./light-completion.js";
import type { FinishTaskImage, LightTaskContract } from "./light-contracts.js";
import {
  lightToolContext,
  type LightWorkspaceExecutor,
} from "./light-executor.js";
import { LightFinishService } from "./light-finish-service.js";

export type FinishTaskScreenshots = {
  // Returns the ids that were not taken in this conversation.
  unknown(ids: string[], context: AgentToolContext): Promise<string[]>;
};

export type FinishTaskOptions = {
  conversationId: string;
  executor?: LightWorkspaceExecutor;
  onComplete?(notification: LightCompletionNotification): Promise<void> | void;
  onValidationActivity?(
    activity: LightValidationActivity,
  ): Promise<void> | void;
  screenshots?: FinishTaskScreenshots;
  // Removes temporary files before the finish checks; returns a note.
  cleanup?(): Promise<string | undefined>;
  taskContract?: LightTaskContract;
  workspaceRoot: string;
};

export function createFinishTaskTool(options: FinishTaskOptions) {
  const service = options.executor
    ? undefined
    : new LightFinishService(options);
  return createLightCompletionTool(async (summary, images, context) => {
    await assertKnownScreenshots(options, images, context);
    const note = await cleanupNote(options);
    const result = service
      ? await service.finish(summary, context, images)
      : await finishRemotely(options, summary, images, context);
    return note ? `${result}\n\n${note}` : result;
  });
}

// A cleanup failure never blocks the finish; it is reported instead.
async function cleanupNote(options: FinishTaskOptions) {
  try {
    return await options.cleanup?.();
  } catch (error) {
    return `Temporary preview files could not be removed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// An unknown reference fails the call so the agent can fix it, rather than
// being dropped from the answer without a word.
export async function assertKnownScreenshots(
  options: Pick<FinishTaskOptions, "screenshots">,
  images: FinishTaskImage[],
  context: AgentToolContext,
) {
  if (!images.length) return;
  const ids = images.map(({ id }) => id);
  const unknown = options.screenshots
    ? await options.screenshots.unknown(ids, context)
    : ids;
  if (!unknown.length) return;
  throw new Error(
    `finish_task images must be screenshots taken in this conversation. Unknown: ${unknown
      .map((id) => `screenshot:${id}`)
      .join(
        ", ",
      )}. Use the exact reference from a preview_devtools__take_screenshot result, take the screenshot again, or remove the image.`,
  );
}

async function finishRemotely(
  options: FinishTaskOptions,
  summary: string,
  images: FinishTaskImage[],
  context: AgentToolContext,
) {
  const result = await options.executor!(
    {
      input: {
        summary,
        ...(images.length
          ? {
              images: images.map(({ caption, id }) => ({
                caption,
                ref: `screenshot:${id}`,
              })),
            }
          : {}),
      },
      taskContract: options.taskContract,
      tool: "finish_task",
      toolContext: lightToolContext(context),
      workspaceRoot: options.workspaceRoot,
    },
    context.signal,
  );
  if (result.status !== "ok") throw new Error(result.message);
  const data = recordValue(result.data);
  const notification = data.notification as
    | LightCompletionNotification
    | undefined;
  const activities = Array.isArray(data.validationActivities)
    ? (data.validationActivities as LightValidationActivity[])
    : [];
  for (const activity of activities)
    await options.onValidationActivity?.(activity);
  // The remote workspace does not know the screenshots: they were checked
  // here, and travel with the notification from here.
  if (notification)
    await options.onComplete?.({
      ...notification,
      ...(images.length ? { images } : {}),
    });
  return typeof data.summary === "string" ? data.summary : summary;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
