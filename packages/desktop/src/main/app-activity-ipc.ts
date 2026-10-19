import { app, BrowserWindow, ipcMain, Notification } from "electron";

// Keeps the app's presence outside its window in sync with what the agents
// do: window title, dock/taskbar badge, attention requests, and system
// notifications that open the right place when clicked.

export type NotificationTarget = {
  pathname: string;
  storyId?: string;
  chatId?: string;
  tab?: string;
};

type AppActivityOptions = {
  mainWindow: () => BrowserWindow | undefined;
  baseTitle: () => string;
};

export function registerAppActivityIpc(options: AppActivityOptions) {
  ipcMain.handle("notifications:show", (_event, input) =>
    showSystemNotification(input, options),
  );
  ipcMain.handle("app:set-activity", (_event, input) => {
    setActivity(input, options);
  });
  ipcMain.handle("app:request-attention", () => {
    requestAttention(options.mainWindow());
  });
}

function showSystemNotification(input: unknown, options: AppActivityOptions) {
  if (!Notification.isSupported()) return false;
  if (!systemNotificationInput(input)) return false;
  const notification = new Notification({
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
  });
  const target = notificationTarget(input.target);
  notification.on("click", () => {
    const window = options.mainWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (target) window.webContents.send("notifications:clicked", target);
  });
  notification.show();
  return true;
}

function setActivity(input: unknown, options: AppActivityOptions) {
  if (!input || typeof input !== "object") return;
  const record = input as Record<string, unknown>;
  const running =
    typeof record.running === "number" && Number.isInteger(record.running)
      ? Math.max(0, Math.min(record.running, 99))
      : 0;
  const window = options.mainWindow();
  const base = options.baseTitle();
  window?.setTitle(running ? `● ${base} — ${agentsLabel(running)}` : base);
  // Dock badge on macOS, launcher badge on supported Linux desktops.
  if (process.platform !== "win32") app.setBadgeCount(running);
  // Windows has no numeric badge: an indeterminate taskbar progress shows
  // that agents are working.
  else window?.setProgressBar(running ? 2 : -1, { mode: running ? "indeterminate" : "none" });
}

function requestAttention(window: BrowserWindow | undefined) {
  if (!window || window.isFocused()) return;
  if (process.platform === "darwin") {
    app.dock?.bounce("informational");
    return;
  }
  window.flashFrame(true);
  window.once("focus", () => window.flashFrame(false));
}

function agentsLabel(count: number) {
  return count === 1 ? "1 agent working" : `${count} agents working`;
}

function systemNotificationInput(input: unknown): input is {
  body?: string;
  title: string;
  target?: unknown;
} {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  if (typeof record.title !== "string" || !record.title.trim()) return false;
  if (record.body !== undefined && typeof record.body !== "string")
    return false;
  return true;
}

export function notificationTarget(value: unknown): NotificationTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const pathname = shortString(record.pathname);
  if (!pathname?.startsWith("/")) return undefined;
  const storyId = shortString(record.storyId);
  const chatId = shortString(record.chatId);
  const tab = shortString(record.tab);
  return {
    pathname,
    ...(storyId ? { storyId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(tab ? { tab } : {}),
  };
}

function shortString(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    ? value
    : undefined;
}
