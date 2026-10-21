import { BrowserWindow, type WebContents } from "electron";

// Every window showing the app (the status PiP aside): the project each one
// has open, and the one the user used last.

const windows = new Set<BrowserWindow>();
const projects = new Map<BrowserWindow, string>();
const focusListeners = new Set<(window: BrowserWindow) => void>();
let lastFocused: BrowserWindow | undefined;

export function trackAppWindow(window: BrowserWindow) {
  windows.add(window);
  window.on("focus", () => {
    lastFocused = window;
    focusListeners.forEach((listener) => listener(window));
  });
  window.on("closed", () => {
    windows.delete(window);
    projects.delete(window);
    if (lastFocused === window) lastFocused = undefined;
  });
}

export function appWindows() {
  return [...windows].filter((window) => !window.isDestroyed());
}

export function appWindowFromSender(sender: WebContents) {
  const window = BrowserWindow.fromWebContents(sender);
  return window && windows.has(window) ? window : undefined;
}

export function isAppWindowSender(sender: WebContents) {
  return Boolean(appWindowFromSender(sender));
}

// The window the user worked in last, or any open one.
export function lastFocusedAppWindow() {
  if (lastFocused && !lastFocused.isDestroyed()) return lastFocused;
  return appWindows().at(-1);
}

export function onAppWindowFocus(listener: (window: BrowserWindow) => void) {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

export function setAppWindowProject(sender: WebContents, path: unknown) {
  const window = appWindowFromSender(sender);
  if (!window) return;
  if (typeof path === "string" && path) projects.set(window, path);
  else projects.delete(window);
}

export function appWindowWithProject(path: string, except?: WebContents) {
  return appWindows().find(
    (window) =>
      window.webContents !== except &&
      sameProjectPath(projects.get(window), path),
  );
}

export function sameProjectPath(left: string | undefined, right: string) {
  if (!left) return false;
  const normalize = (value: string) => value.replace(/[\\/]+$/, "");
  return normalize(left) === normalize(right);
}
