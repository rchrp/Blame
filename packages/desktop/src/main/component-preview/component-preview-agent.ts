import {
  ComponentPreviewService,
  type ComponentPreviewRenderInput,
} from "./component-preview-service.ts";

// The agent host's entry for open_component_preview. Nothing starts before
// the first call: the service, its browser page and its server are created
// on demand.

let service: ComponentPreviewService | undefined;

function componentPreviewService() {
  service ??= new ComponentPreviewService({
    browser: async () =>
      (await import("./component-preview-browser.ts"))
        .electronComponentPreviewBrowser,
    locate: async (target, file) =>
      (await import("./component-preview-location.ts")).locateComponentPreview(
        target,
        file,
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
) {
  const request = recordValue(input);
  const worktree = optionalText(request.worktree);
  if (!worktree) throw new Error("Invalid component preview request");
  if (request.action === "stop")
    return { stopped: await stopComponentPreviews({ worktree }) };
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
    ...optionalField("toolCallId", request.toolCallId),
  };
  return componentPreviewService().render(renderInput, signal);
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
