import { homedir } from "node:os";
import { join } from "node:path";
import { shutdownBlameTelemetry } from "@blame/telemetry";
import contextMenu from "electron-context-menu";
import windowState from "electron-window-state";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import {
  configureAgentRuntimeTelemetry,
  disableAgentRuntimeTelemetry,
  prewarmAgentRuntime,
  shutdownAgentRuntime,
} from "./agent-ipc";
import { desktopAppIdentity } from "./desktop-app-identity";
import { DesktopAuthCallbackDeliveryQueue } from "./desktop-auth-callback-delivery";
import {
  desktopAuthCallback,
  desktopDeepLink,
  desktopProtocolClientArguments,
} from "./desktop-auth-deep-link";
import { desktopResourcePaths } from "./desktop-resource-paths";
import {
  attachLiveLogWindow,
  flushLiveLogs,
  registerLiveLogCapture,
} from "./desktop-live-log";
import { checkForUpdatesOnStartup } from "./desktop-update-ipc";
import { destroyAllPreviewBrowsers } from "./preview-browser-ipc";
import { shutdownPreviewDevtoolsMcp } from "./preview-runtime/preview-devtools-mcp-service";
import { shutdownTerminalSessions } from "./terminal-ipc";
import { shutdownWorkspaceProcesses } from "./workspace-ipc";
import { setupPath } from "./host-tool-path";
import { stopRuntimeInBackground } from "./runtime-manager";
import { runtimeHostPath, runtimeVmInternalPath } from "./workspace-runtime";
import { registerAppActivityIpc } from "./app-activity-ipc";
import { registerDesktopIpcHandlers } from "./ipc";
import { configureHyprlandWindow } from "./hyprland-window";
import {
  isMainWindowRole,
  mainWindowPresentation,
  type MainWindowPresentation,
  type MainWindowRole,
} from "./main-window-presentation";
import { createMainWindowNavigationGuard } from "./main-window-navigation";
import {
  appWindowWithProject,
  appWindows,
  isAppWindowSender,
  setAppWindowProject,
  trackAppWindow,
} from "./app-windows";

contextMenu({
  showInspectElement: true,
  showLookUpSelection: false,
  showSaveImageAs: true,
  showSearchWithGoogle: false,
});

const desktopResources = desktopResourcePaths(app.getAppPath());
const runtimeShutdownTimeoutMs = 4_000;
const telemetryShutdownTimeoutMs = 4_000;
const initialWindowShowFallbackMs = 8_000;
type WindowBounds = { height: number; width: number; x: number; y: number };
const protocolClientArguments = desktopProtocolClientArguments(
  app.isPackaged,
  process.execPath,
  process.argv,
);

try {
  process.chdir(homedir());
} catch {}

const appIdentity = desktopAppIdentity(app.isPackaged);
const billingDeepLink = "blame://billing/refresh";
app.setName(appIdentity.name);
app.setAppUserModelId(appIdentity.appId);
app.setPath("userData", join(app.getPath("appData"), appIdentity.appId));
if (protocolClientArguments.length === 0) {
  app.setAsDefaultProtocolClient("blame");
} else {
  app.setAsDefaultProtocolClient(
    "blame",
    protocolClientArguments[0],
    protocolClientArguments[1],
  );
}
registerLiveLogCapture();

const appImageTaskSmoke = process.env.BLAME_APPIMAGE_RUN_TASK_SMOKE === "true";
const singleInstanceLock = appImageTaskSmoke || app.requestSingleInstanceLock();

if (!singleInstanceLock) app.exit(0);

let mainWindow: BrowserWindow | undefined;
let mainWindowRole: MainWindowRole | undefined;
// Extra workspace windows, each opened on another project. The main window
// is the one that can switch between compact and workspace.
const projectWindows = new Set<BrowserWindow>();
let shutdownPromise: Promise<void> | undefined;
let shutdownRequested = false;
let readyToQuit = false;
const initialDeepLink = desktopDeepLink(process.argv);
let pendingBillingRefresh = initialDeepLink === billingDeepLink;
const authCallbackQueue = new DesktopAuthCallbackDeliveryQueue();
const initialAuthCallback = desktopAuthCallback(initialDeepLink);
if (initialAuthCallback) authCallbackQueue.enqueue(initialAuthCallback);
let authRendererReady = false;

void app.whenReady().then(() => {
  if (appImageTaskSmoke) {
    void finishAppImageTaskSmoke();
    return;
  }
  registerDesktopIpcHandlers({
    mainWindow: () => mainWindow,
    isAppWindow: isAppWindowSender,
    packaged: app.isPackaged,
    registerCoreHandlers: registerIpcHandlers,
    backlogStatusPip: {
      preloadPath: desktopResources.preload,
      rendererFile: desktopResources.renderer,
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
    },
    agentRuntime: {
      modulePath: desktopResources.agentRuntime,
      serviceVersion: app.getVersion(),
    },
    telemetry: {
      configure: configureAgentRuntimeTelemetry,
      disable: disableAgentRuntimeTelemetry,
    },
    async beforeInstall() {
      shutdownRequested = true;
      await shutdownApplication();
      readyToQuit = true;
    },
    onRuntimeReady: () => void prewarmAgentRuntime(true),
  });
  replaceMainWindow("compact");
  checkForUpdatesOnStartup();
});

async function finishAppImageTaskSmoke() {
  try {
    const { runAppImageTaskSmoke } = await import("./appimage-run-task-smoke");
    await runAppImageTaskSmoke();
    console.log("Packaged AppImage run_task smoke test passed");
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    app.exit(1);
  }
}

app.on("activate", () => {
  if (shutdownRequested) return;
  if (!mainWindow || mainWindow.isDestroyed()) replaceMainWindow("compact");
});

app.on("second-instance", (_event, commandLine) => {
  if (shutdownRequested) return;
  showMainWindow();
  handleDeepLink(desktopDeepLink(commandLine));
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  shutdownRequested = true;
  if (readyToQuit) return;
  event.preventDefault();
  void quitGracefully();
});

process.once("SIGINT", () => {
  void exitFromSignal();
});

process.once("SIGTERM", () => {
  void exitFromSignal();
});

function createMainWindow(
  role: MainWindowRole,
  pathname?: string,
  replacedWindow?: BrowserWindow,
  project?: string,
) {
  const presentation = mainWindowPresentation(appIdentity.name, role);
  const state = createWorkspaceWindowState(role, presentation);
  const bounds = mainWindowBounds(role, presentation, state);
  const fittedPresentation = {
    ...presentation,
    height: bounds.height,
    width: bounds.width,
  };
  const window = new BrowserWindow(
    mainWindowOptions(role, presentation, bounds),
  );

  trackAppWindow(window);
  registerMainWindowEvents(window);
  protectMainWindowNavigation(window);
  preventRendererTitleChanges(window);
  hidePlatformWindowButtons(window);
  state?.manage(window);
  attachLiveLogWindow(window);
  registerWindowStateEvents(window);
  loadRenderer(window, role, pathname, project);
  scheduleInitialWindowShow(window, role, fittedPresentation, replacedWindow);
  return window;
}

function protectMainWindowNavigation(window: BrowserWindow) {
  const guard = createMainWindowNavigationGuard({
    openExternal: (url) => void shell.openExternal(url),
    rendererFile: desktopResources.renderer,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
  });
  window.webContents.on("will-navigate", guard.handleNavigation);
  window.webContents.on("will-redirect", guard.handleRedirect);
  window.webContents.setWindowOpenHandler(guard.handleWindowOpen);
}

function mainWindowOptions(
  role: MainWindowRole,
  presentation: MainWindowPresentation,
  bounds: WindowBounds,
): BrowserWindowConstructorOptions {
  return {
    ...bounds,
    minHeight: Math.min(presentation.minHeight, bounds.height),
    minWidth: Math.min(presentation.minWidth, bounds.width),
    show: false,
    title: presentation.title,
    autoHideMenuBar: true,
    backgroundColor: "#00000000",
    frame: false,
    fullscreenable: role === "workspace",
    maximizable: role === "workspace",
    resizable: presentation.resizable,
    transparent: process.platform !== "win32",
    ...(role === "compact"
      ? { maxHeight: bounds.height, maxWidth: bounds.width }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: desktopResources.preload,
      sandbox: true,
    },
    ...(process.platform === "win32" ? windowsWindowOptions() : {}),
    ...(process.platform === "darwin" ? macosWindowOptions() : {}),
  };
}

function registerMainWindowEvents(window: BrowserWindow) {
  window.on("close", (event) => {
    if (process.platform === "darwin" || readyToQuit) return;
    // Closing one of several windows only closes it; the last one quits.
    if (appWindows().some((other) => other !== window)) return;
    event.preventDefault();
    shutdownRequested = true;
    void quitGracefully();
  });
  window.on("closed", () => {
    projectWindows.delete(window);
    if (mainWindow !== window) return;
    // Another project window takes over as the main window.
    const next = [...projectWindows].find((other) => !other.isDestroyed());
    if (next) projectWindows.delete(next);
    mainWindow = next;
    mainWindowRole = next ? "workspace" : undefined;
  });
}

// Opens a project in a window of its own, or brings forward the window that
// already has it: two windows on one backlog would run its stories twice.
function openProjectWindow(path: string) {
  const existing = appWindowWithProject(path);
  if (existing) {
    showPresentedWindow(existing);
    return "focused";
  }
  const window = createMainWindow("workspace", undefined, undefined, path);
  offsetFromOpenWindows(window);
  projectWindows.add(window);
  return "opened";
}

// Windows share their saved bounds: cascade a new one so it does not hide
// the window it was opened from.
function offsetFromOpenWindows(window: BrowserWindow) {
  const bounds = window.getBounds();
  const taken = (x: number, y: number) =>
    appWindows().some((other) => {
      if (other === window) return false;
      const position = other.getBounds();
      return position.x === x && position.y === y;
    });
  let { x, y } = bounds;
  while (taken(x, y)) {
    x += 28;
    y += 28;
  }
  if (x !== bounds.x) window.setPosition(x, y);
}

function preventRendererTitleChanges(window: BrowserWindow) {
  window.on("page-title-updated", (event) => event.preventDefault());
}

function createWorkspaceWindowState(
  role: MainWindowRole,
  presentation: MainWindowPresentation,
) {
  if (role !== "workspace") return;
  return windowState({
    defaultHeight: presentation.height,
    defaultWidth: presentation.width,
  });
}

function mainWindowBounds(
  role: MainWindowRole,
  presentation: MainWindowPresentation,
  state?: ReturnType<typeof windowState>,
) {
  if (role === "compact") {
    const display = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    return fitWindowBounds(presentation, display);
  }
  return fitWindowBounds({
    height: Math.max(
      state?.height ?? presentation.height,
      presentation.minHeight,
    ),
    width: Math.max(state?.width ?? presentation.width, presentation.minWidth),
    x: state?.x,
    y: state?.y,
  });
}

function fitWindowBounds(
  bounds: { height: number; width: number; x?: number; y?: number },
  targetDisplay = screen.getDisplayMatching({
    height: bounds.height,
    width: bounds.width,
    x: bounds.x ?? 0,
    y: bounds.y ?? 0,
  }),
) {
  const display = targetDisplay;
  const area = display.workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = clamp(
    bounds.x ?? area.x + Math.round((area.width - width) / 2),
    area.x,
    area.x + area.width - width,
  );
  const y = clamp(
    bounds.y ?? area.y + Math.round((area.height - height) / 2),
    area.y,
    area.y + area.height - height,
  );
  return { height, width, x, y };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function handleDeepLink(url: string | undefined) {
  if (url === billingDeepLink) pendingBillingRefresh = true;
  else {
    const callback = desktopAuthCallback(url);
    if (!callback) return;
    authCallbackQueue.enqueue(callback);
  }
  showMainWindow();
  if (!mainWindow || mainWindow.webContents.isLoading()) return;
  if (pendingBillingRefresh) {
    pendingBillingRefresh = false;
    mainWindow.webContents.send("billing:refresh-license");
  }
  deliverPendingAuthCallback(mainWindow.webContents);
}

function deliverPendingAuthCallback(webContents: WebContents) {
  if (!authRendererReady || webContents.isDestroyed()) return;
  const delivery = authCallbackQueue.pending();
  if (!delivery) return;
  webContents.send("auth:callback", delivery);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    replaceMainWindow("compact");
    return;
  }
  showPresentedWindow(mainWindow);
}

function windowsWindowOptions(): BrowserWindowConstructorOptions {
  return {
    backgroundMaterial: "acrylic",
  };
}

function macosWindowOptions(): BrowserWindowConstructorOptions {
  return {
    vibrancy: "under-window",
    visualEffectState: "active",
  };
}

function hidePlatformWindowButtons(window: BrowserWindow) {
  if (process.platform !== "darwin") return;
  window.setWindowButtonVisibility(false);
}

function loadRenderer(
  window: BrowserWindow,
  role: MainWindowRole,
  pathname?: string,
  project?: string,
) {
  const query = rendererQuery(role, pathname, project);
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }
    void window.loadURL(url.toString());
    return;
  }
  void window.loadFile(desktopResources.renderer, { query });
}

function rendererQuery(
  role: MainWindowRole,
  pathname?: string,
  project?: string,
) {
  return {
    "window-role": role,
    ...(pathname ? { route: pathname } : {}),
    ...(project ? { project } : {}),
  };
}

function registerIpcHandlers() {
  registerAppActivityIpc({
    baseTitle: () =>
      mainWindowPresentation(appIdentity.name, mainWindowRole ?? "workspace")
        .title,
    mainWindow: () =>
      mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
  });

  ipcMain.handle("window:is-maximized", (event) => {
    return getEventWindow(event)?.isMaximized() ?? false;
  });

  ipcMain.handle("window:minimize", (event) => {
    getEventWindow(event)?.minimize();
  });

  ipcMain.handle("window:set-presentation", (event, input) => {
    return setWindowPresentation(getEventWindow(event), input);
  });

  ipcMain.handle("window:toggle-maximize", (event) => {
    const window = getEventWindow(event);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });

  ipcMain.on("window:close", (event) => {
    getEventWindow(event)?.close();
  });

  ipcMain.handle("window:open-project", (event, path: unknown) => {
    if (!isAppWindowSender(event.sender) || !validProjectPath(path)) return;
    return openProjectWindow(path);
  });

  // Brings forward another window that has this project open.
  ipcMain.handle("window:focus-project", (event, path: unknown) => {
    if (!isAppWindowSender(event.sender) || !validProjectPath(path))
      return false;
    const window = appWindowWithProject(path, event.sender);
    if (!window) return false;
    showPresentedWindow(window);
    return true;
  });

  ipcMain.on("window:report-project", (event, path: unknown) => {
    setAppWindowProject(event.sender, validProjectPath(path) ? path : null);
  });

  ipcMain.handle(
    "dialog:open-directory",
    async (_event, options?: { title?: string; multiple?: boolean }) => {
      const result = await dialog.showOpenDialog({
        properties: [
          "openDirectory",
          ...(options?.multiple ? ["multiSelections" as const] : []),
        ],
        title: options?.title ?? "Open Project",
      });
      if (result.canceled) return null;
      return options?.multiple ? result.filePaths : result.filePaths[0];
    },
  );

  ipcMain.on("shell:open-external", (_event, url: string) => {
    void shell.openExternal(url);
  });

  ipcMain.on("billing:renderer-ready", (event) => {
    if (!pendingBillingRefresh) return;
    pendingBillingRefresh = false;
    event.sender.send("billing:refresh-license");
  });

  ipcMain.handle("auth:renderer-ready", (event) => {
    if (event.sender !== mainWindow?.webContents) return undefined;
    authRendererReady = true;
    return authCallbackQueue.pending();
  });

  ipcMain.on("auth:callback-received", (event, deliveryId: unknown) => {
    if (
      event.sender !== mainWindow?.webContents ||
      typeof deliveryId !== "number"
    ) {
      return;
    }
    authCallbackQueue.acknowledge(deliveryId);
  });

  ipcMain.handle("shell:open-path", (_event, path: string) => {
    if (
      process.platform === "darwin" &&
      runtimeVmInternalPath(path, "darwin")
    ) {
      return "This worktree is stored inside BlameRuntime for performance. Open it from Blame's Files or Terminal view.";
    }
    return shell.openPath(runtimeHostPath(path));
  });
}

function setWindowPresentation(window: BrowserWindow | null, input: unknown) {
  if (!window || window !== mainWindow || !windowPresentationInput(input)) {
    return false;
  }
  if (input.role === mainWindowRole) return true;
  replaceMainWindow(input.role, input.pathname);
  return true;
}

function replaceMainWindow(role: MainWindowRole, pathname?: string) {
  authRendererReady = false;
  const replacedWindow = mainWindow;
  mainWindow = createMainWindow(role, pathname, replacedWindow);
  mainWindowRole = role;
}

function scheduleInitialWindowShow(
  window: BrowserWindow,
  role: MainWindowRole,
  presentation: MainWindowPresentation,
  replacedWindow?: BrowserWindow,
) {
  let presented = false;
  const present = () => {
    if (presented || window.isDestroyed()) return;
    presented = true;
    showPresentedWindow(window);
    configureHyprlandWindow({ presentation, role });
    destroyReplacedWindow(replacedWindow);
  };
  window.once("ready-to-show", present);
  setTimeout(present, initialWindowShowFallbackMs);
}

function showPresentedWindow(window: BrowserWindow) {
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

function destroyReplacedWindow(window: BrowserWindow | undefined) {
  if (window && !window.isDestroyed()) window.destroy();
}

function windowPresentationInput(input: unknown): input is {
  pathname?: string;
  role: MainWindowRole;
} {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  if (!isMainWindowRole(record.role)) return false;
  return validRendererPathname(record.pathname);
}

function validProjectPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function validRendererPathname(value: unknown) {
  if (value === undefined) return true;
  return (
    typeof value === "string" && value.startsWith("/") && value.length <= 2048
  );
}

function registerWindowStateEvents(window: BrowserWindow) {
  window.on("maximize", () =>
    window.webContents.send("window:maximized", true),
  );
  window.on("unmaximize", () =>
    window.webContents.send("window:maximized", false),
  );
}

function getEventWindow(event: IpcMainInvokeEvent | IpcMainEvent) {
  return BrowserWindow.fromWebContents(event.sender);
}

async function quitGracefully() {
  shutdownRequested = true;
  await shutdownApplication();
  readyToQuit = true;
  app.quit();
}

async function exitFromSignal() {
  await shutdownApplication();
  app.exit(0);
}

function shutdownApplication() {
  if (!shutdownPromise) shutdownPromise = cleanupApplication();
  return shutdownPromise;
}

async function cleanupApplication() {
  destroyAllPreviewBrowsers();
  const runtimeShutdown = Promise.allSettled([
    shutdownTerminalSessions(),
    shutdownWorkspaceProcesses(),
    shutdownAgentRuntime(),
    shutdownPreviewDevtoolsMcp(),
  ]).then(() => undefined);
  await settleWithin(runtimeShutdown, runtimeShutdownTimeoutMs);
  stopRuntimeInBackground({ ...process.env, PATH: setupPath() });
  await settleWithin(shutdownBlameTelemetry(), telemetryShutdownTimeoutMs);
  await settleWithin(flushLiveLogs(), telemetryShutdownTimeoutMs);
}

function settleWithin(task: Promise<void>, timeout: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeout);
    void task.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
