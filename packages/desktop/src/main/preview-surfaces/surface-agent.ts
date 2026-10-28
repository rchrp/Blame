import { deviceAction } from "../preview-devices/device-actions.ts";
import { displaySurfaceAction } from "./display-surface.ts";
import { storePreviewDevtoolsScreenshots } from "../agent-screenshots/agent-screenshots-service.ts";
import type { PreviewService } from "../preview-runtime/preview-service.ts";
import { localPreviewContext } from "../preview-runtime/local/local-preview-runner.ts";
import { surfaceEnabled } from "./experimental-surfaces.ts";
import { terminalSurfaceAction } from "./surface-sessions.ts";

export async function agentSurfaceInfo(
  input: { worktree: string },
  previews: PreviewService,
) {
  const context = await localPreviewContext(input.worktree).catch(
    () => undefined,
  );
  if (!context?.selected) return;
  if (context.selected.category === "desktop" && !context.selected.services.length && !context.selected.previewService) return { type: "host-window" } as const;
  const target = context.manifest.devices?.find((d) => d.id === context.selected?.previewTarget);
  if (target && surfaceEnabled(target.platform)) return { type: "device", targetId: target.id } as const;
  const service = context.manifest.services.find(
    (s) => s.id === context.selected?.previewService,
  );
  const type = service?.surface?.type;
  if (service && (type === "terminal" || type === "display") && surfaceEnabled(type))
    return { type, serviceId: type === "display" ? `${service.id}__display` : service.id } as const;
}

export async function agentSurfaceCall(
  input: {
    worktree: string;
    storyId?: string;
    projectId?: string;
    sessionId?: string;
    toolCallId?: string;
    workspaceMode?: string;
    arguments: Record<string, unknown>;
  },
  previews: PreviewService,
  signal?: AbortSignal,
) {
  const surface = await agentSurfaceInfo(input, previews);
  if (!surface || !input.storyId)
    return {
      status: "unavailable",
      message: "This story has no interactive preview.",
    };
  if (surface.type === "host-window") return { status: "unavailable", message: "The app opens in its own window. Use project_app in a Direct story; ask the user to check its interface." };
  if (surface.type === "device") {
    const scope = { storyId: input.storyId, projectId: input.projectId ?? input.storyId, worktree: input.worktree, targetId: surface.targetId, workspaceMode: input.workspaceMode === "cloud-mirror" ? "cloud-mirror" as const : input.workspaceMode === "direct" ? "direct" as const : "local-container" as const };
    return storePreviewDevtoolsScreenshots(await deviceAction(scope, input.arguments), { scope: input.storyId, sessionId: input.sessionId, toolCallId: input.toolCallId });
  }
  const cloud =
    input.workspaceMode === "cloud-mirror"
      ? await previews.findForUserStory(input.storyId, "vercel-compose")
      : undefined;
  const scope = { storyId: input.storyId, serviceId: surface.serviceId, worktree: input.worktree, sessionId: cloud?.session?.id };
  if (surface.type === "display") return storePreviewDevtoolsScreenshots(await displaySurfaceAction(scope, input.arguments, previews), { scope: input.storyId });
  return terminalSurfaceAction(
    {
      storyId: input.storyId,
      serviceId: surface.serviceId,
      worktree: input.worktree,
      sessionId: cloud?.session?.id,
    },
    input.arguments,
    signal,
  );
}
