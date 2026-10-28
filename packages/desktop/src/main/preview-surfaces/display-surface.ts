import { displayActionCommand, displayActionResult } from "@blame/preview-runtime/compose";
import { localPreviewContext, localPreviewEngine } from "../preview-runtime/local/local-preview-runner.ts";
import type { PreviewService } from "../preview-runtime/preview-service.ts";
import type { SurfaceScope } from "./surface-upstream.ts";
import { surfaceEnabled } from "./experimental-surfaces.ts";

export async function displaySurfaceAction(scope: SurfaceScope, args: Record<string, unknown>, previews: PreviewService) {
  if (!surfaceEnabled("display")) return { status: "unavailable", message: "Screen previews are not enabled on this computer." };
  const command = displayActionCommand(args);
  if (scope.sessionId) {
    const session = await previews.get(scope.sessionId);
    if (session.userStoryId !== scope.storyId) throw new Error("This preview does not belong to this story.");
    return displayActionResult(args.action, await previews.surfaceAction(scope.sessionId, scope.serviceId, args));
  }
  if (!scope.worktree) return { status: "unavailable", message: "The preview workspace is unavailable." };
  const context = await localPreviewContext(scope.worktree);
  const service = context.plan.services.find((s) => s.id === scope.serviceId);
  if (service?.surface?.type !== "display" || service.surface.sidecarServiceId !== service.id) throw new Error("This preview has no screen.");
  const result = await localPreviewEngine(scope.worktree).execInService(service.id, command, { timeoutMs: 15000 });
  return displayActionResult(args.action, result);
}
