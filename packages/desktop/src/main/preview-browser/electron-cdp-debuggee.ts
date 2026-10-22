import type { WebContents } from "electron";
import type { CdpDebuggee } from "./preview-cdp-proxy.ts";
export { previewNavigationPolicy } from "./preview-navigation-policy.ts";

type ElectronDebuggeeOptions = {
  contentSize(): { height: number; width: number };
  setContentSize?(width: number, height: number): Promise<void> | void;
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
        return { targetId: targetInfo.targetId };
      } catch (error) {
        release();
        throw error;
      }
    },
    contentSize: options.contentSize,
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
      return debuggerApi.sendCommand(method, params, sessionId);
    },
    ...(options.setContentSize
      ? { setContentSize: options.setContentSize }
      : {}),
    title: () => (webContents.isDestroyed() ? "" : webContents.getTitle()),
    url: () => (webContents.isDestroyed() ? "" : webContents.getURL()),
    userAgent: () =>
      webContents.isDestroyed() ? "" : webContents.getUserAgent(),
    versions: { chrome: process.versions.chrome, v8: process.versions.v8 },
  };
}
