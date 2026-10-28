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
  const service = context.manifest.services.find(
    (s) => s.id === context.selected?.previewService,
  );
  const type = service?.surface?.type;
  if (service && type === "terminal" && surfaceEnabled(type))
    return { type, serviceId: service.id } as const;
}

export async function agentSurfaceCall(
  input: {
    worktree: string;
    storyId?: string;
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
  const cloud =
    input.workspaceMode === "cloud-mirror"
      ? await previews.findForUserStory(input.storyId, "vercel-compose")
      : undefined;
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
