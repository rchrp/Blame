import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { setupPath } from "../host-tool-path";
import {
  ensureRuntimeReady,
  getRuntimeStatus,
  repairRuntime,
  resetRuntime,
  stopRuntime,
  uninstallRuntime,
  type RuntimeProgress,
  type RuntimeStatusReport,
} from "../runtime-manager";
import {
  configureRuntimePower,
  onRuntimeRunning,
  runtimeLifecycleOperation,
  type RuntimeAvailability,
  type RuntimePowerEvent,
} from "../runtime-power";
import { schedulePreviewCleanup } from "../workspace-ipc";
import { resetRuntimeGitIdentityConfigured } from "../workspace-runtime";

type RuntimeOperationInput = {
  operationId?: string;
};

/**
 * The Blame Runtime for the app windows: its state, the operations they
 * ask for, and when it starts and stops (see runtime-power.ts), which every
 * window hears on `workspace:runtime-power`.
 */
export function registerRuntimeIpcHandlers() {
  if (process.platform === "darwin" || process.platform === "win32") {
    configureRuntimePower({
      availability: async () =>
        runtimeAvailability(
          await getRuntimeStatus({ env: runtimeManagerEnvironment() }),
        ),
      async start(onProgress) {
        resetRuntimeGitIdentityConfigured();
        const report = await ensureRuntimeReady({
          env: runtimeManagerEnvironment(),
          onProgress,
        });
        if (runtimeAvailability(report) !== "running")
          throw new Error(runtimeStartFailure(report));
      },
      stop: () => stopRuntime({ env: runtimeManagerEnvironment() }),
      notify: broadcastRuntimePower,
    });
    onRuntimeRunning(schedulePreviewCleanup);
  }
  ipcMain.handle("workspace:get-runtime-status", () =>
    getRuntimeStatus({ env: runtimeManagerEnvironment() }),
  );
  registerRuntimeOperationHandler(
    "workspace:ensure-runtime-ready",
    ensureRuntimeReady,
  );
  registerRuntimeOperationHandler("workspace:repair-runtime", repairRuntime);
  registerRuntimeOperationHandler("workspace:reset-runtime", resetRuntime);
  ipcMain.handle("workspace:uninstall-runtime", () =>
    runtimeLifecycleOperation(() => {
      resetRuntimeGitIdentityConfigured();
      return uninstallRuntime({ env: runtimeManagerEnvironment() });
    }),
  );
}

function registerRuntimeOperationHandler(
  channel: string,
  operation: typeof ensureRuntimeReady,
) {
  ipcMain.handle(channel, (event, input: RuntimeOperationInput = {}) =>
    runtimeLifecycleOperation(async () => {
      resetRuntimeGitIdentityConfigured();
      const report = await operation({
        env: runtimeManagerEnvironment(),
        onProgress: runtimeProgressReporter(event, input.operationId),
      });
      if (report.status === "ready") schedulePreviewCleanup();
      return report;
    }),
  );
}

function runtimeProgressReporter(
  event: IpcMainInvokeEvent,
  operationId?: string,
) {
  if (!operationId || !/^[a-f0-9-]{36}$/.test(operationId)) return undefined;
  const channel = `workspace:runtime-progress:${operationId}`;
  return (progress: RuntimeProgress) => {
    if (event.sender.isDestroyed()) return;
    try {
      event.sender.send(channel, progress);
    } catch {
      return;
    }
  };
}

function broadcastRuntimePower(event: RuntimePowerEvent) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send("workspace:runtime-power", event);
  }
}

// An installed runtime whose provisioning lags behind still runs: the app
// updates it once no local story needs it.
export function runtimeAvailability(
  report: RuntimeStatusReport,
): RuntimeAvailability {
  if (report.status === "ready" || report.updateRequired) return "running";
  if (report.status === "missing" || report.status === "unsupported")
    return "unavailable";
  return "stopped";
}

function runtimeStartFailure(report: RuntimeStatusReport) {
  const issue = report.issues[0];
  return issue?.action ?? `Blame Runtime could not start (${report.status}).`;
}

function runtimeManagerEnvironment() {
  return {
    ...process.env,
    PATH: setupPath(),
  };
}
