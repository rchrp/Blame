import WebSocket from "ws";
import type { PreviewService } from "../preview-runtime/preview-service.ts";
import { localPreviewEndpoints } from "../preview-runtime/local/local-preview-runner.ts";

export type SurfaceScope = {
  storyId: string;
  serviceId: string;
  worktree?: string;
  sessionId?: string;
  columns?: number;
  rows?: number;
};

export async function surfaceUpstream(
  scope: SurfaceScope,
  endpointId: string,
  previews: PreviewService,
  protocol?: string,
) {
  let url: URL;
  let headers: Record<string, string> = {};
  if (scope.sessionId) {
    const session = await previews.get(scope.sessionId);
    if (session.userStoryId !== scope.storyId)
      throw new Error("Preview session does not belong to this story.");
    const route = session.endpointMap?.routes.find(
      (r) => r.serviceId === scope.serviceId && r.endpointId === endpointId,
    );
    if (!route)
      throw new Error("Start this preview before opening its screen.");
    const ticket = await previews.surfaceAccessTicket(
      scope.sessionId,
      route.routeId,
    );
    const openUrl = new URL(ticket.openUrl);
    url = new URL(route.publicUrl);
    if (openUrl.protocol !== "https:" || openUrl.origin !== url.origin)
      throw new Error("Preview access ticket destination is invalid.");
    const response = await fetch(openUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: ticket.ticket }),
      signal: AbortSignal.timeout(15000),
    });
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-blame_preview="));
    if (response.status !== 303 || !cookie)
      throw new Error("Preview authorization expired. Open the preview again.");
    headers = { Cookie: cookie.split(";", 1)[0]! };
    url.protocol = "wss:";
  } else {
    if (!scope.worktree) throw new Error("Preview workspace is unavailable.");
    const { routes } = await localPreviewEndpoints(scope.worktree);
    const route = routes.find(
      (r) => r.serviceId === scope.serviceId && r.endpointId === endpointId,
    );
    if (!route) throw new Error("Start this preview before connecting.");
    url = new URL(`ws://127.0.0.1:${route.port}/`);
  }
  url.pathname = endpointId === "terminal" ? "/ws" : "/websockify";
  return new WebSocket(url, protocol ? [protocol] : [], {
    headers,
    handshakeTimeout: 15000,
    maxPayload: 4 * 1024 * 1024,
  });
}
