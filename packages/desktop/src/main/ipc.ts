import { registerPreviewDevicesIpc } from "./ipc/preview-devices-ipc";
import {
  ipcMain,
  shell,
  systemPreferences,
  type BrowserWindow,
  type WebContents,
} from "electron";
import { openAttachment } from "./attachment-open";
import { installApplicationMenu } from "./application-menu";
import { localAgentOwnsWorkspace, registerAgentIpcHandlers } from "./agent-ipc";
import { registerAppearanceIpcHandlers } from "./appearance-ipc";
import { registerAgentScreenshotIpcHandlers } from "./ipc/agent-screenshots-ipc";
import { registerPreviewDevtoolsSettingsIpcHandlers } from "./ipc/preview-devtools-settings-ipc";
import { registerProjectAppIpcHandlers } from "./ipc/project-app-ipc";
import { registerBacklogStatusPipIpcHandlers } from "./backlog-status-pip-ipc";
import { registerCloudAuthIpcHandlers } from "./cloud-auth-ipc";
import { registerDesktopUpdateIpcHandlers } from "./desktop-update-ipc";
import { DeployService } from "./deploy/deploy-service";
import { registerDeployIpcHandlers } from "./ipc/deploy-ipc";
import { registerMcpIpcHandlers } from "./mcp-ipc";
import { registerPreviewBrowserIpcHandlers } from "./preview-browser-ipc";
import { PreviewService } from "./preview-runtime/preview-service";
import { registerPreviewRuntimeIpcHandlers } from "./ipc/preview-runtime-ipc";
import { registerTelemetryIpcHandlers } from "./telemetry-ipc";
import { registerTerminalIpcHandlers } from "./terminal-ipc";
import { registerPreviewSurfacesIpc } from "./ipc/preview-surfaces-ipc";
import {
  localPreviewBridgeGrant,
  registerWorkspaceIpcHandlers,
} from "./workspace-ipc";

export type DesktopIpcOptions = {
  mainWindow(): BrowserWindow | undefined;
  // Any window showing the app, the status PiP aside.
  isAppWindow(sender: WebContents): boolean;
  packaged: boolean;
  registerCoreHandlers(): void;
  backlogStatusPip: {
    preloadPath: string;
    rendererFile: string;
    rendererUrl?: string;
  };
  agentRuntime: {
    modulePath: string;
    serviceVersion: string;
  };
  telemetry: {
    configure: NonNullable<
      Parameters<typeof registerTelemetryIpcHandlers>[0]
    >["configure"];
    disable: NonNullable<
      Parameters<typeof registerTelemetryIpcHandlers>[0]
    >["disable"];
  };
  beforeInstall(): Promise<void>;
  onRuntimeReady(): void;
};

export function registerDesktopIpcHandlers(options: DesktopIpcOptions) {
  const setProjectMenuReady = installApplicationMenu();
  ipcMain.on("project-menu:ready", (event, ready: unknown) => {
    if (!options.isAppWindow(event.sender) || typeof ready !== "boolean")
      return;
    setProjectMenuReady(event.sender, ready);
  });
  registerAppearanceIpcHandlers({ isAppWindow: options.isAppWindow });
  const previews = new PreviewService(
    localAgentOwnsWorkspace,
    options.packaged,
  );
  const deploy = new DeployService(options.packaged);
  registerPreviewDevicesIpc({ isAppWindow: options.isAppWindow });
  registerPreviewSurfacesIpc({ service: previews, isAppWindow: options.isAppWindow });
  options.registerCoreHandlers();
  ipcMain.handle("shell:open-attachment", (event, input: unknown) => {
    if (!options.isAppWindow(event.sender)) throw new Error("Untrusted attachment request");
    return openAttachment(input);
  });
  ipcMain.handle("media:request-microphone", () => requestMicrophoneAccess());
  ipcMain.handle("media:open-microphone-settings", () =>
    openMicrophoneSettings(),
  );
  registerCloudAuthIpcHandlers({
    isAppWindow: options.isAppWindow,
    packaged: options.packaged,
  });
  registerBacklogStatusPipIpcHandlers({
    ...options.backlogStatusPip,
  });
  registerAgentIpcHandlers({
    ...options.agentRuntime,
    packaged: options.packaged,
    previewService: previews,
    beforeDelivery: (worktree) => previews.syncBarrier(worktree),
    beforeWorkspaceWrite: (worktree) => previews.syncBarrier(worktree),
  });
  registerPreviewRuntimeIpcHandlers({
    isAppWindow: options.isAppWindow,
    service: previews,
  });
  registerDeployIpcHandlers({
    isAppWindow: options.isAppWindow,
    service: deploy,
  });
  registerPreviewBrowserIpcHandlers({
    bridgeGrant: (source) =>
      source.kind === "cloud"
        ? previews.bridgeGrant(source.sessionId)
        : localPreviewBridgeGrant(source.worktree),
  });
  registerAgentScreenshotIpcHandlers({ isAppWindow: options.isAppWindow });
  registerProjectAppIpcHandlers({ isAppWindow: options.isAppWindow });
  registerPreviewDevtoolsSettingsIpcHandlers({
    isAppWindow: options.isAppWindow,
  });
  registerMcpIpcHandlers();
  registerTerminalIpcHandlers();
  registerTelemetryIpcHandlers(options.telemetry);
  registerDesktopUpdateIpcHandlers({ beforeInstall: options.beforeInstall });
  registerWorkspaceIpcHandlers({
    beforeGitWrite: (worktree) => previews.syncBarrier(worktree),
    onRuntimeReady: options.onRuntimeReady,
  });
}

// macOS asks once. After a refusal it answers "denied" without showing
// anything again, so the app offers to open the Microphone settings.
async function requestMicrophoneAccess() {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  if (status === "denied" || status === "restricted") return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
}

function openMicrophoneSettings() {
  if (process.platform === "darwin") {
    return shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    );
  }
  if (process.platform === "win32") {
    return shell.openExternal("ms-settings:privacy-microphone");
  }
}
