import { BrowserWindow, session, type Session } from "electron";
import {
  componentPreviewViewportHeight,
  openComponentPreviewPage,
} from "./component-preview-page.ts";
import { componentPreviewRequestAllowed } from "./component-preview-page-policy.ts";
import type { ComponentPreviewBrowser } from "./component-preview-service.ts";

// Component previews render in pages of their own, reserved for the agent
// like its preview browser but never the page preview_devtools__* drives:
// emulating a width or a theme here leaves the story's preview untouched.
// They use a separate in-memory session, so no route of the preview's
// network bridge is shared or replaced, and that session only lets them
// load their temporary server.

const partition = "blame-component-preview";
const allowedOrigins = new Set<string>();
let guardedSession: Session | undefined;

export const electronComponentPreviewBrowser: ComponentPreviewBrowser = {
  openPage(origin) {
    const window = new BrowserWindow({
      height: componentPreviewViewportHeight,
      show: false,
      useContentSize: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
        sandbox: true,
        session: componentPreviewSession(),
      },
      width: 1_280,
    });
    allowedOrigins.add(origin);
    return openComponentPreviewPage(window, {
      onClose: () => allowedOrigins.delete(origin),
      origin,
    });
  },
};

function componentPreviewSession() {
  if (guardedSession) return guardedSession;
  const previewSession = session.fromPartition(partition, { cache: false });
  previewSession.webRequest.onBeforeRequest((details, callback) =>
    callback({
      cancel: !componentPreviewRequestAllowed(details.url, allowedOrigins),
    }),
  );
  previewSession.setPermissionRequestHandler((_contents, _permission, allow) =>
    allow(false),
  );
  guardedSession = previewSession;
  return previewSession;
}
