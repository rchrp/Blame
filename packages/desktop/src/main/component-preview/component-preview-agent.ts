import log from "electron-log";
import type { CloudComponentPreviews } from "./component-preview-cloud-host.ts";
import {
  ComponentPreviewService,
  type ComponentPreviewRenderInput,
} from "./component-preview-service.ts";

// The agent host's entry for open_component_preview. Nothing starts before
// the first call: the service, its browser page and its server are created
// on demand. A cloud preview's server runs in its sandbox, through the
// desktop's cloud preview service.

let service: ComponentPreviewService | undefined;

function componentPreviewService(cloud: CloudComponentPreviews | undefined) {
  service ??= new ComponentPreviewService({
    browser: async () =>
      (await import("./component-preview-browser.ts"))
        .electronComponentPreviewBrowser,
    locate: async (target, file) =>
      (await import("./component-preview-location.ts")).locateComponentPreview(
        target,
        file,
        cloud
          ? async (cloudTarget) =>
              (
                await import("./component-preview-cloud-host.ts")
              ).cloudComponentPreviewHostFor(cloud, cloudTarget)
          : undefined,
      ),
    storeScreenshots: async (result, context) =>
      (
        await import("../agent-screenshots/agent-screenshots-service.ts")
      ).storePreviewDevtoolsScreenshots(result, context),
  });
  return service;
}

export async function componentPreviewHostRequest(
  input: unknown,
  signal: AbortSignal,
  cloud?: CloudComponentPreviews,
) {
  const request = recordValue(input);
  const worktree = optionalText(request.worktree);
  if (!worktree) throw new Error("Invalid component preview request");
  if (request.action === "stop") {
    const stopped = await stopComponentPreviews({ worktree });
    // finish_task removed the preview files first: a cloud preview's
    // sandbox gets their removal now. Other worktrees have nothing to send.
    await cloud?.syncBarrier(worktree).catch((error: unknown) =>
      log.warn(
        "Could not send the removed component previews to the cloud preview",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      ),
    );
    return { stopped };
  }
  if (request.action !== "render")
    throw new Error("Invalid component preview action");
  const workspaceMode = request.workspaceMode;
  const renderInput: ComponentPreviewRenderInput = {
    request: request.request,
    worktree,
    ...(workspaceMode === "cloud-mirror" ||
    workspaceMode === "direct" ||
    workspaceMode === "local-container"
      ? { workspaceMode }
      : {}),
    ...optionalField("runId", request.runId),
    ...optionalField("scope", request.scope),
    ...optionalField("sessionId", request.sessionId),
    ...optionalField("storyId", request.storyId),
    ...optionalField("toolCallId", request.toolCallId),
  };
  return componentPreviewService(cloud).render(renderInput, signal);
}

// finish_task stops the worktree's server; a cancelled or ended run stops
// the servers its session used.
export function stopComponentPreviews(selector: {
  sessionId?: string;
  worktree?: string;
}) {
  return service ? service.stop(selector) : Promise.resolve(0);
}

export async function shutdownComponentPreviews() {
  await service?.shutdown();
}

function optionalField<Key extends string>(key: Key, value: unknown) {
  const text = optionalText(value);
  return (text ? { [key]: text } : {}) as Partial<Record<Key, string>>;
}

function optionalText(value: unknown) {
  return typeof value === "string" && value && value.length <= 4_096
    ? value
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
