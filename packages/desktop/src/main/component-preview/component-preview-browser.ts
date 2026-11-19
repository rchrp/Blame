import { BrowserWindow, session, type Session } from "electron";
import {
  componentPreviewViewportHeight,
  openComponentPreviewPage,
} from "./component-preview-page.ts";
import { componentPreviewRequestAllowed } from "./component-preview-page-policy.ts";
import type { ComponentPreviewBrowser } from "./component-preview-service.ts";
import { paintOnDemand } from "../preview-browser/offscreen-painting.ts";

// Component previews render in pages of their own, reserved for the agent
// like its preview browser but never the page preview_devtools__* drives:
// emulating a width or a theme here leaves the story's preview untouched.
// They use a separate in-memory session, so no route of the preview's
// network bridge is shared or replaced, and that session only lets them
// load their temporary server. A page stays open between captures but
// paints only while it captures.

const partition = "blame-component-preview";
// Electron's default for offscreen pages.
const componentPreviewFrameRate = 60;
const allowedOrigins = new Set<string>();
let guardedSession: Session | undefined;

export const electronComponentPreviewBrowser: ComponentPreviewBrowser = {
  async openPage(origin) {
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
    const painting = paintOnDemand(window.webContents, {
      frameRate: componentPreviewFrameRate,
      graceMs: 0,
    });
    const page = await openComponentPreviewPage(window, {
      onClose: () => {
        painting.dispose();
        allowedOrigins.delete(origin);
      },
      origin,
    });
    return {
      async capture(input) {
        const done = painting.begin();
        try {
          return await page.capture(input);
        } finally {
          done();
        }
      },
      close: () => page.close(),
    };
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
