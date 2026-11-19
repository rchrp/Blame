import { tmpdir } from "node:os";

// Stands in for Electron when a test loads main process modules in plain
// Node: IPC handlers are kept so the test can call them like the app does.
// Load it with useElectronTestStub() before importing those modules.

export const ipcHandlers = new Map<
  string,
  (event: unknown, input?: unknown) => unknown
>();

/** Whether the window that sends the next IPC call is on screen. */
export const testWindow = { visible: true };

// Whatever a module calls at load time on the rest of Electron does nothing.
const inert: object = new Proxy(() => inert, {
  get: (_target, key) => (key === "then" ? undefined : inert),
  apply: () => inert,
  construct: () => inert,
});

export const ipcMain = {
  handle: (
    channel: string,
    handler: (event: unknown, input?: unknown) => unknown,
  ) => void ipcHandlers.set(channel, handler),
  on: () => undefined,
  removeHandler: (channel: string) => void ipcHandlers.delete(channel),
};

export class BrowserWindow {
  static getAllWindows() {
    return [];
  }
  static fromWebContents() {
    return {
      isMinimized: () => !testWindow.visible,
      isVisible: () => testWindow.visible,
    };
  }
}

export const app = new Proxy(
  {
    getPath: () => tmpdir(),
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => undefined,
    whenReady: () => Promise.resolve(),
  } as Record<string | symbol, unknown>,
  { get: (target, key) => (key in target ? target[key] : inert) },
);

export const ClipboardItem = inert;
export const Menu = inert;
export const Notification = inert;
export const WebContentsView = inert;
export const clipboard = inert;
export const dialog = inert;
export const nativeImage = inert;
export const nativeTheme = inert;
export const net = inert;
export const safeStorage = inert;
export const screen = inert;
export const session = inert;
export const shell = inert;
export const systemPreferences = inert;
export const utilityProcess = inert;
export default { app, BrowserWindow, ipcMain };
