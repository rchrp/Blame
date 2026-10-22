import type { WebContents } from "electron";
import type { CdpDebuggee } from "./preview-cdp-proxy.ts";
export { previewNavigationPolicy } from "./preview-navigation-policy.ts";

type Size = { height: number; width: number };

type ElectronDebuggeeOptions = {
  activity?(): void;
  contentSize?(): Size;
  // An emulated viewport at scale 1, applied on attach and restored when
  // emulation is cleared. Captures then have the requested size whatever
  // screen the hidden window would be clamped to, and whatever its density.
  viewport?: { get(): Size; set(size: Size): void };
};

// Only one proxy may drive a page's debugger at a time. A new connection
// replaces the previous one instead of failing on "already attached".
const owners = new WeakMap<WebContents, () => void>();

export function electronCdpDebuggee(
  webContents: WebContents,
  options: ElectronDebuggeeOptions,
): CdpDebuggee {
  const debuggerApi = webContents.debugger;
  let attached = false;
  const release = () => {
    if (!attached) return;
    attached = false;
    if (owners.get(webContents) === release) owners.delete(webContents);
    if (!webContents.isDestroyed() && debuggerApi.isAttached()) {
      try {
        debuggerApi.detach();
      } catch {}
    }
  };
  return {
    async attach() {
      if (webContents.isDestroyed())
        throw new Error("The preview page is no longer available.");
      owners.get(webContents)?.();
      if (debuggerApi.isAttached())
        throw new Error("The preview page is already being debugged.");
      debuggerApi.attach("1.3");
      attached = true;
      owners.set(webContents, release);
      try {
        const { targetInfo } = (await debuggerApi.sendCommand(
          "Target.getTargetInfo",
        )) as { targetInfo: { targetId: string } };
        if (options.viewport)
          await debuggerApi.sendCommand(
            "Emulation.setDeviceMetricsOverride",
            baselineMetrics(options.viewport.get()),
          );
        return { targetId: targetInfo.targetId };
      } catch (error) {
        release();
        throw error;
      }
    },
    contentSize: () =>
      options.viewport?.get() ??
      options.contentSize?.() ?? { height: 0, width: 0 },
    detach: release,
    onDetach(listener) {
      const detached = () => {
        if (attached) {
          attached = false;
          listener();
        }
      };
      const destroyed = () => detached();
      debuggerApi.on("detach", detached);
      webContents.once("destroyed", destroyed);
      return () => {
        debuggerApi.off("detach", detached);
        webContents.off("destroyed", destroyed);
      };
    },
    onMessage(listener) {
      const message = (
        _event: unknown,
        method: string,
        params: unknown,
        sessionId?: string,
      ) => listener(method, params, sessionId || undefined);
      debuggerApi.on("message", message);
      return () => debuggerApi.off("message", message);
    },
    sendCommand(method, params, sessionId) {
      if (!attached) return Promise.reject(new Error("Target closed"));
      options.activity?.();
      if (
        method === "Emulation.clearDeviceMetricsOverride" &&
        !sessionId &&
        options.viewport
      )
        return debuggerApi.sendCommand(
          "Emulation.setDeviceMetricsOverride",
          baselineMetrics(options.viewport.get()),
        );
      return debuggerApi.sendCommand(method, params, sessionId);
    },
    ...(options.viewport
      ? {
          async setContentSize(width: number, height: number) {
            options.viewport!.set({ height, width });
            if (attached)
              await debuggerApi.sendCommand(
                "Emulation.setDeviceMetricsOverride",
                baselineMetrics({ height, width }),
              );
          },
        }
      : {}),
    title: () => (webContents.isDestroyed() ? "" : webContents.getTitle()),
    url: () => (webContents.isDestroyed() ? "" : webContents.getURL()),
    userAgent: () =>
      webContents.isDestroyed() ? "" : webContents.getUserAgent(),
    versions: { chrome: process.versions.chrome, v8: process.versions.v8 },
  };
}

function baselineMetrics({ height, width }: Size) {
  return { deviceScaleFactor: 1, height, mobile: false, width };
}
