import {
  BrowserWindow,
  ipcMain,
  nativeTheme,
  screen,
  type BrowserWindowConstructorOptions,
  type Rectangle,
} from "electron";

const windowWidth = 360;
const windowHeight = 600;
const minWindowWidth = 320;
const minWindowHeight = 360;
const edgeMargin = 24;
const statusPipView = "backlog-status-pip";
const compactWidth = 300;
const compactMinHeight = 72;
const compactMaxHeight = 420;
const resizeDurationMs = 220;

let statusPipWindow: BrowserWindow | undefined;
let latestStatusPipSnapshot: unknown;
// Size to come back to when leaving compact mode.
let expandedSize: { height: number; width: number } | undefined;
let stopResize: (() => void) | undefined;

export function registerBacklogStatusPipIpcHandlers(input: {
  mainWindow(): BrowserWindow | undefined;
  preloadPath: string;
  rendererFile: string;
  rendererUrl?: string;
}) {
  ipcMain.handle("backlog-status-pip:open", () => openStatusPipWindow(input));
  ipcMain.handle("backlog-status-pip:request", (_event, request) =>
    sendStatusPipRequest(input.mainWindow(), request),
  );
  ipcMain.on("backlog-status-pip:close", (event) => {
    if (event.sender === statusPipWindow?.webContents) statusPipWindow.close();
  });
  ipcMain.handle("backlog-status-pip:set-mode", (event, input) => {
    if (!statusPipWindow || event.sender !== statusPipWindow.webContents)
      return false;
    return setStatusPipMode(statusPipWindow, input);
  });
  ipcMain.handle(
    "backlog-status-pip:latest-snapshot",
    () => latestStatusPipSnapshot,
  );
  ipcMain.on("backlog-status-pip:snapshot", (_event, snapshot) => {
    latestStatusPipSnapshot = snapshot;
    sendStatusPipSnapshot(statusPipWindow, snapshot);
  });
}

function openStatusPipWindow(input: {
  mainWindow(): BrowserWindow | undefined;
  preloadPath: string;
  rendererFile: string;
  rendererUrl?: string;
}) {
  if (statusPipWindow && !statusPipWindow.isDestroyed()) {
    showStatusPipWindow(statusPipWindow);
    sendLatestStatusPipSnapshot(statusPipWindow);
    return true;
  }

  const window = new BrowserWindow(windowOptions(input.preloadPath));
  statusPipWindow = window;
  window.setAspectRatio(0);
  window.on("closed", () => {
    if (statusPipWindow === window) statusPipWindow = undefined;
  });
  loadStatusPipRenderer(window, input);
  window.webContents.once("did-finish-load", () =>
    sendLatestStatusPipSnapshot(window),
  );
  window.once("ready-to-show", () => showStatusPipWindow(window));
  return true;
}

function windowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  const bounds = defaultBounds();
  return {
    ...bounds,
    minHeight: minWindowHeight,
    minWidth: minWindowWidth,
    show: false,
    title: "Active User Stories",
    type: "toolbar",
    alwaysOnTop: true,
    autoHideMenuBar: true,
    // The page draws its own header with drag, compact and close controls.
    frame: false,
    roundedCorners: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
    fullscreenable: false,
    maximizable: false,
    resizable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
    },
  };
}

function defaultBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(windowWidth, area.width);
  const height = Math.min(windowHeight, area.height);
  return {
    height,
    width,
    x: Math.max(area.x, area.x + area.width - width - edgeMargin),
    y: Math.min(area.y + edgeMargin, area.y + area.height - height),
  };
}

function loadStatusPipRenderer(
  window: BrowserWindow,
  input: {
    rendererFile: string;
    rendererUrl?: string;
  },
) {
  if (input.rendererUrl) {
    void window.loadURL(`${input.rendererUrl}?view=${statusPipView}`);
    return;
  }
  void window.loadFile(input.rendererFile, {
    query: { view: statusPipView },
  });
}

function showStatusPipWindow(window: BrowserWindow) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function sendStatusPipRequest(
  window: BrowserWindow | undefined,
  request: unknown,
) {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send("backlog-status-pip:request", request);
  return true;
}

function sendLatestStatusPipSnapshot(window: BrowserWindow | undefined) {
  if (latestStatusPipSnapshot === undefined) return;
  sendStatusPipSnapshot(window, latestStatusPipSnapshot);
}

function sendStatusPipSnapshot(
  window: BrowserWindow | undefined,
  snapshot: unknown,
) {
  if (!window || window.isDestroyed()) return false;
  window.webContents.send("backlog-status-pip:snapshot", snapshot);
  return true;
}

// Compact mode: a slim list sized to its content. Expanded: the size the
// window had before. The top-right corner stays put, so the window grows
// and shrinks away from the screen edge it usually sits on.
function setStatusPipMode(window: BrowserWindow, input: unknown) {
  const mode = statusPipMode(input);
  if (!mode) return false;
  const current = window.getBounds();
  if (mode.compact) {
    if (window.isResizable()) expandedSize = { height: current.height, width: current.width };
    window.setMinimumSize(compactWidth, compactMinHeight);
    window.setResizable(false);
  } else {
    window.setResizable(true);
  }
  const width = mode.compact ? compactWidth : (expandedSize?.width ?? windowWidth);
  const height = mode.compact
    ? clamp(mode.contentHeight ?? compactMinHeight, compactMinHeight, compactMaxHeight)
    : (expandedSize?.height ?? windowHeight);
  const area = screen.getDisplayMatching(current).workArea;
  const target = {
    height: Math.min(height, area.height),
    width,
    x: Math.max(area.x, current.x + current.width - width),
    y: clamp(current.y, area.y, area.y + area.height - Math.min(height, area.height)),
  };
  animateBounds(window, target, () => {
    if (!mode.compact) window.setMinimumSize(minWindowWidth, minWindowHeight);
  });
  return true;
}

function animateBounds(window: BrowserWindow, target: Rectangle, done: () => void) {
  stopResize?.();
  if (process.platform === "darwin") {
    window.setBounds(target, true);
    done();
    return;
  }
  const from = window.getBounds();
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const step = () => {
    if (window.isDestroyed()) return;
    const progress = Math.min((Date.now() - start) / resizeDurationMs, 1);
    const eased = 1 - (1 - progress) ** 3;
    window.setBounds({
      height: Math.round(from.height + (target.height - from.height) * eased),
      width: Math.round(from.width + (target.width - from.width) * eased),
      x: Math.round(from.x + (target.x - from.x) * eased),
      y: Math.round(from.y + (target.y - from.y) * eased),
    });
    if (progress < 1) timer = setTimeout(step, 16);
    else {
      stopResize = undefined;
      done();
    }
  };
  stopResize = () => {
    clearTimeout(timer);
    stopResize = undefined;
  };
  step();
}

function statusPipMode(input: unknown) {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.compact !== "boolean") return undefined;
  const contentHeight =
    typeof record.contentHeight === "number" && Number.isFinite(record.contentHeight)
      ? Math.round(record.contentHeight)
      : undefined;
  return { compact: record.compact, contentHeight };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
