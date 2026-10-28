import {
  parsePreviewManifest,
  type PreviewManifest,
} from "@blame/preview-contract";
type PreviewSurfaceInfo = {
  type: "device" | "terminal" | "display" | "host-window";
  serviceId?: string;
  targetId?: string;
};
import { deviceAction } from "../preview-devices/device-actions.ts";
import { displaySurfaceAction } from "./display-surface.ts";
import { storePreviewDevtoolsScreenshots } from "../agent-screenshots/agent-screenshots-service.ts";
import type { PreviewService } from "../preview-runtime/preview-service.ts";
import { localPreviewContext } from "../preview-runtime/local/local-preview-runner.ts";
import { surfaceEnabled } from "./experimental-surfaces.ts";
import { terminalSurfaceAction } from "./surface-sessions.ts";

export async function agentSurfaceInfo(
  input: {
    worktree: string;
    surface?: PreviewSurfaceInfo;
    previewManifest?: PreviewManifest;
    workspaceMode?: string;
  },
  previews: PreviewService,
) {
  const context =
    input.workspaceMode === "direct" || input.workspaceMode === "cloud-mirror"
      ? undefined
      : await localPreviewContext(input.worktree).catch(() => undefined);
  const manifest =
    context?.manifest ??
    (input.previewManifest
      ? parsePreviewManifest(input.previewManifest)
      : undefined);
  if (!manifest) return;
  if (
    context?.selected
      ? context.selected.category === "desktop" &&
        !context.selected.services.length &&
        !context.selected.previewTarget
      : input.surface?.type === "host-window"
  )
    return { type: "host-window" } as const;
  const targetId = context?.selected?.previewTarget ?? input.surface?.targetId;
  const target = manifest.devices?.find((d) => d.id === targetId);
  if (target && surfaceEnabled(target.platform))
    return { type: "device", targetId: target.id } as const;
  const serviceId =
    context?.selected?.previewService ?? input.surface?.serviceId;
  const service = manifest.services.find(
    (s) =>
      s.id === serviceId ||
      (s.surface?.type === "display" && `${s.id}__display` === serviceId),
  );

  const type = service?.surface?.type;
  if (
    service &&
    (type === "terminal" || type === "display") &&
    surfaceEnabled(type)
  )
    return {
      type,
      serviceId: type === "display" ? `${service.id}__display` : service.id,
    } as const;
}

export async function agentSurfaceCall(
  input: {
    worktree: string;
    storyId?: string;
    projectId?: string;
    sessionId?: string;
    toolCallId?: string;
    workspaceMode?: string;
    surface?: PreviewSurfaceInfo;
    previewManifest?: PreviewManifest;
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
  if (surface.type === "host-window")
    return {
      status: "unavailable",
      message:
        "The app opens in its own window. Use project_app in a Direct story; ask the user to check its interface.",
    };
  if (surface.type === "device") {
    const scope = {
      storyId: input.storyId,
      projectId: input.projectId ?? input.storyId,
      worktree: input.worktree,
      targetId: surface.targetId,
      manifest: input.previewManifest,
      workspaceMode:
        input.workspaceMode === "cloud-mirror"
          ? ("cloud-mirror" as const)
          : input.workspaceMode === "direct"
            ? ("direct" as const)
            : ("local-container" as const),
    };
    return storePreviewDevtoolsScreenshots(
      await deviceAction(scope, input.arguments),
      {
        scope: input.storyId,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
      },
    );
  }
  const cloud =
    input.workspaceMode === "cloud-mirror"
      ? await previews.findForUserStory(input.storyId, "vercel-compose")
      : undefined;
  const scope = {
    storyId: input.storyId,
    serviceId: surface.serviceId,
    worktree: input.worktree,
    sessionId: cloud?.session?.id,
  };
  if (surface.type === "display")
    return storePreviewDevtoolsScreenshots(
      await displaySurfaceAction(scope, input.arguments, previews),
      {
        scope: input.storyId,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
      },
    );
  const terminal = input.previewManifest?.services.find(
    (s) => s.id === surface.serviceId,
  )?.surface;
  return terminalSurfaceAction(
    {
      storyId: input.storyId,
      serviceId: surface.serviceId,
      ...(terminal?.type === "terminal"
        ? { columns: terminal.columns, rows: terminal.rows }
        : {}),
      worktree: input.worktree,
      sessionId: cloud?.session?.id,
    },
    input.arguments,
    signal,
  );
}
