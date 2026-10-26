import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";
import { publicWebUrl } from "@blame/agent-runtime/web-network";
import { researchProxy } from "./web-research-proxy.ts";

let active = 0;

export async function renderResearchPage(
  value: string,
  callerSignal: AbortSignal,
) {
  const url = publicWebUrl(value);
  if (active >= 2)
    throw new Error(
      "Two web pages are already rendering. Retry after they finish.",
    );
  callerSignal.throwIfAborted();
  active++;
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(25_000)]);
  let window: BrowserWindow | undefined;
  let proxy: Awaited<ReturnType<typeof researchProxy>> | undefined;
  const isolated = session.fromPartition(`web-research-${randomUUID()}`, {
    cache: false,
  });
  const abort = () => window?.destroy();
  try {
    proxy = await researchProxy(signal);
    // <-loopback> removes Chromium's implicit proxy bypass for loopback hosts.
    await isolated.setProxy({
      proxyRules: proxy.url,
      proxyBypassRules: "<-loopback>",
    });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    isolated.setPermissionCheckHandler(() => false);
    isolated.on("will-download", (event) => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try {
        publicWebUrl(details.url);
        allowed = ["GET", "HEAD", "OPTIONS"].includes(details.method);
      } catch {
        /* denied */
      }
      callback({
        cancel:
          !allowed ||
          ["image", "media", "font", "ping", "webSocket"].includes(
            details.resourceType,
          ),
      });
    });
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        spellcheck: false,
        disableBlinkFeatures: "WebRTC,WebBluetooth,WebUSB,WebSerial",
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    await window.loadURL(url.href);
    // Allow hydration to settle, with a hard deadline even on constantly changing pages.
    const page = (await window.webContents.executeJavaScriptInIsolatedWorld(
      999,
      [
        {
          code: `new Promise(resolve => {
      let last = '', stable = 0, ticks = 0;
      const timer = setInterval(() => {
        const text = document.body?.innerText || '';
        stable = text === last ? stable + 1 : 0; last = text;
        if ((text.length > 140 && stable >= 3) || ++ticks >= 24) {
          clearInterval(timer); resolve({url: location.href, html: document.documentElement.outerHTML.slice(0, 5000000)});
        }
      }, 250);
    })`,
        },
      ],
    )) as { url: string; html: string };
    signal.throwIfAborted();
    publicWebUrl(page.url);
    return page;
  } finally {
    signal.removeEventListener("abort", abort);
    if (window && !window.isDestroyed()) window.destroy();
    await isolated.closeAllConnections().catch(() => {});
    proxy?.close();
    await isolated.clearStorageData().catch(() => {});
    active--;
  }
}
