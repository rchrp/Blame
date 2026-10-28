import { app, ipcMain, type WebContents } from "electron";
import type { PreviewService } from "../preview-runtime/preview-service.ts";
import {
  attachSurfaceTerminal,
  configureSurfaceSessions,
  stopSurfaceTerminals,
  surfaceTerminalById,
} from "../preview-surfaces/surface-sessions.ts";
import { experimentalSurfaces } from "../preview-surfaces/experimental-surfaces.ts";
import type { SurfaceScope } from "../preview-surfaces/surface-upstream.ts";

export function registerPreviewSurfacesIpc(options: {
  service: PreviewService;
  isAppWindow(sender: WebContents): boolean;
}) {
  configureSurfaceSessions(options.service);
  const authorized = (sender: WebContents) => {
    if (!options.isAppWindow(sender))
      throw new Error("Untrusted preview request");
  };
  ipcMain.handle("preview-surfaces:enabled", (event) => {
    authorized(event.sender);
    return experimentalSurfaces();
  });
  ipcMain.handle(
    "preview-terminal:attach",
    async (event, scope: SurfaceScope) => {
      authorized(event.sender);
      if (
        !scope ||
        typeof scope.storyId !== "string" ||
        typeof scope.serviceId !== "string"
      )
        throw new Error("Preview scope is invalid");
      const { session, replay, state } = await attachSurfaceTerminal(scope);
      const channel = `preview-terminal:event:${session.id}`;
      const send = (value: unknown) => {
        if (!event.sender.isDestroyed())
          event.sender.send(channel, { ...(value as object), id: session.id });
      };
      // Reattaching the same view replaces its subscription.
      const key = `${event.sender.id}:${session.id}`;
      subscriptions.get(key)?.();
      session.terminal.on("event", send);
      const cleanup = () => {
        session.terminal.off("event", send);
        subscriptions.delete(key);
        event.sender.off("destroyed", cleanup);
      };
      subscriptions.set(key, cleanup);
      event.sender.once("destroyed", cleanup);
      return { id: session.id, replay, ...state };
    },
  );
  ipcMain.handle("preview-terminal:detach", (event, id: string) => {
    authorized(event.sender);
    subscriptions.get(`${event.sender.id}:${id}`)?.();
  });
  ipcMain.handle("preview-terminal:write", (event, input) => {
    authorized(event.sender);
    return owned(event.sender, input.id)?.write(String(input.data));
  });
  ipcMain.handle("preview-terminal:resize", (event, input) => {
    authorized(event.sender);
    return owned(event.sender, input.id)?.resize(input.cols, input.rows);
  });
  ipcMain.handle("preview-terminal:restart", (event, id: string) => {
    authorized(event.sender);
    return owned(event.sender, id)?.restart();
  });
  ipcMain.handle("preview-terminal:read", (event, id: string) => {
    authorized(event.sender);
    return owned(event.sender, id)?.snapshot();
  });
  app.once("before-quit", () => stopSurfaceTerminals());
}
const subscriptions = new Map<string, () => void>();
function owned(sender: WebContents, id: string) {
  if (!subscriptions.has(`${sender.id}:${id}`))
    throw new Error("Attach this preview before using it.");
  return surfaceTerminalById(id);
}
