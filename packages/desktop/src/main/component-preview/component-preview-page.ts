import type { WebContents } from "electron";
import { componentPreviewRequestAllowed } from "./component-preview-page-policy.ts";
import type {
  ComponentPreviewCapture,
  ComponentPreviewPage,
} from "./component-preview-service.ts";

// One page of the agent's browser that renders component previews: it
// loads its temporary server, emulates a width and a theme, waits for the
// page to say it rendered, and captures it through the DevTools protocol.

// What the page uses of an Electron BrowserWindow.
export type ComponentPreviewWindow = {
  destroy(): void;
  isDestroyed(): boolean;
  webContents: Pick<
    WebContents,
    | "debugger"
    | "executeJavaScriptInIsolatedWorld"
    | "loadURL"
    | "on"
    | "setAudioMuted"
    | "setWindowOpenHandler"
    | "stop"
  >;
};

export type ComponentPreviewPageOptions = {
  // Bounds each DevTools command and each script read from the page.
  commandTimeoutMs?: number;
  onClose?(): void;
  origin: string;
};

export const componentPreviewViewportHeight = 900;
const defaultCommandTimeoutMs = 15_000;
const maximumCaptureHeight = 4_096;
const isolatedWorld = 1_208;
const pollIntervalMs = 100;
const maximumConsoleErrors = 20;

type PageState = {
  height: number;
  message: string | null;
  overlay: string | null;
  status: string | null;
};

const pageStateProbe = `(() => {
  const html = document.documentElement;
  const overlay = document.querySelector("vite-error-overlay");
  const overlayText = overlay
    ? (overlay.shadowRoot?.querySelector(".message")?.textContent || "The page shows a Vite error.").trim().slice(0, 800)
    : null;
  return {
    height: Math.max(html.scrollHeight, document.body ? document.body.scrollHeight : 0),
    message: html.dataset.blamePreviewMessage || null,
    overlay: overlayText,
    status: html.dataset.blamePreviewStatus || null,
  };
})()`;

// Fonts, then two frames, then a moment for effects that run after mount.
const settleProbe = `(async () => {
  if (document.fonts) await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 150));
  return true;
})()`;

// A window that has loaded no document never answers the Emulation domain:
// the page loads about:blank and attaches the debugger before any render.
export async function openComponentPreviewPage(
  window: ComponentPreviewWindow,
  options: ComponentPreviewPageOptions,
): Promise<ComponentPreviewPage> {
  const page = new BrowserComponentPreviewPage(window, options);
  try {
    await page.open();
    return page;
  } catch (error) {
    page.close();
    throw error;
  }
}

class BrowserComponentPreviewPage implements ComponentPreviewPage {
  private readonly commandTimeoutMs: number;
  private readonly consoleErrors: string[] = [];
  private readonly onClose?: () => void;
  private readonly origin: string;
  private readonly window: ComponentPreviewWindow;
  private closed = false;

  constructor(
    window: ComponentPreviewWindow,
    options: ComponentPreviewPageOptions,
  ) {
    this.window = window;
    this.origin = options.origin;
    this.onClose = options.onClose;
    this.commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
    const contents = window.webContents;
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!componentPreviewRequestAllowed(url, new Set([this.origin])))
        event.preventDefault();
    });
    contents.on("console-message", (_event, level, message, line, source) => {
      if (level === 3 && this.consoleErrors.length < maximumConsoleErrors)
        this.consoleErrors.push(this.consoleLine(message, line, source));
    });
  }

  async open() {
    await withTimeout(
      this.window.webContents.loadURL("about:blank"),
      this.commandTimeoutMs,
      "The preview page did not open.",
    );
    const target = this.window.webContents.debugger;
    if (!target.isAttached()) target.attach("1.3");
  }

  async capture(input: {
    theme: "dark" | "light";
    timeoutMs: number;
    url: string;
    width: number;
  }): Promise<ComponentPreviewCapture> {
    const deadline = Date.now() + input.timeoutMs;
    this.consoleErrors.length = 0;
    await this.command("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: componentPreviewViewportHeight,
      mobile: false,
      width: input.width,
    });
    await this.command("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: input.theme }],
    });
    const viewport = {
      height: componentPreviewViewportHeight,
      width: input.width,
    };
    const loaded = await this.load(input.url, deadline);
    if (loaded !== true)
      return {
        consoleErrors: [...this.consoleErrors],
        message: loaded,
        status: "error",
        url: input.url,
        viewport,
      };
    const finished = await this.waitForPage(deadline);
    await this.evaluate(settleProbe).catch(() => undefined);
    const state = await this.evaluate<PageState>(pageStateProbe);
    const height = Math.min(
      Math.max(Math.ceil(state.height), componentPreviewViewportHeight),
      maximumCaptureHeight,
    );
    const screenshot = await this.command<{ data: string }>(
      "Page.captureScreenshot",
      {
        captureBeyondViewport: true,
        clip: { height, scale: 1, width: input.width, x: 0, y: 0 },
        format: "png",
      },
    );
    return {
      consoleErrors: [...this.consoleErrors],
      image: Buffer.from(screenshot.data, "base64"),
      ...(state.message ? { message: state.message } : {}),
      ...(state.overlay ? { overlay: state.overlay } : {}),
      status:
        state.status === "error" || state.overlay
          ? "error"
          : finished && state.status === "ready"
            ? "ready"
            : "timeout",
      url: input.url,
      viewport,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
    if (!this.window.isDestroyed()) this.window.destroy();
  }

  private async load(url: string, deadline: number): Promise<true | string> {
    const contents = this.window.webContents;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<string>((resolve) => {
      timer = setTimeout(
        () => {
          contents.stop();
          resolve("The page did not load in time.");
        },
        Math.max(deadline - Date.now(), 1),
      );
    });
    try {
      return await Promise.race([
        contents.loadURL(url).then(
          () => true as const,
          (error: unknown) =>
            `The page did not load: ${error instanceof Error ? error.message : String(error)}`,
        ),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Until the page says it rendered or failed, or shows Vite's overlay.
  private async waitForPage(deadline: number) {
    while (Date.now() < deadline) {
      const state = await this.evaluate<PageState>(pageStateProbe).catch(
        () => undefined,
      );
      if (state?.status || state?.overlay) return true;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return false;
  }

  // Read in an isolated world, so page scripts cannot change the answer.
  // A page stuck in a loop never answers: the read gives up.
  private evaluate<T>(code: string) {
    return withTimeout(
      this.window.webContents.executeJavaScriptInIsolatedWorld(isolatedWorld, [
        { code },
      ]) as Promise<T>,
      this.commandTimeoutMs,
      "The preview page did not answer.",
    );
  }

  private command<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ) {
    return withTimeout(
      this.window.webContents.debugger.sendCommand(
        method,
        params,
      ) as Promise<T>,
      this.commandTimeoutMs,
      `The browser did not answer ${method} within ${this.commandTimeoutMs / 1_000} s.`,
    );
  }

  private consoleLine(message: string, line: number, source: string) {
    const where = source.startsWith(this.origin)
      ? source.slice(this.origin.length)
      : source;
    return `${message.slice(0, 600)}${where ? ` (${where}:${line})` : ""}`;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
) {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}
