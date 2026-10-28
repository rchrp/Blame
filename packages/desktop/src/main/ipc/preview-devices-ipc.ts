import { ipcMain, type WebContents } from "electron";
import { deviceRuntime, type DeviceScope } from "../preview-devices/device-runtime.ts";
import { deviceAction } from "../preview-devices/device-actions.ts";
import { openDeviceScreenChannel } from "../preview-devices/device-screen-channel.ts";

export function registerPreviewDevicesIpc(options: { isAppWindow(sender: WebContents): boolean }) {
  const runtime = deviceRuntime();
  const authorized = (sender: WebContents) => { if (!options.isAppWindow(sender)) throw new Error("Untrusted device preview request"); };
  ipcMain.handle("preview-devices:availability", (event, scope: DeviceScope) => { authorized(event.sender); return runtime.availability(scope); });
  ipcMain.handle("preview-devices:state", async (event, scope: DeviceScope) => { authorized(event.sender); await runtime.resolve(scope); return runtime.service.status(scope.storyId); });
  ipcMain.handle("preview-devices:start", (event, scope: DeviceScope) => { authorized(event.sender); return runtime.start(scope); });
  ipcMain.handle("preview-devices:action", async (event, scope: DeviceScope, args: Record<string, unknown>) => { authorized(event.sender); return deviceAction(scope, args); });
  ipcMain.handle("preview-devices:channel", async (event, scope: DeviceScope) => { authorized(event.sender); const availability = await runtime.availability(scope); if (availability.status !== "ready") throw new Error("Set up this device before opening its screen."); return openDeviceScreenChannel(runtime.service, scope.storyId); });
  ipcMain.handle("preview-devices:prerequisite", (event, scope: DeviceScope, id: string) => { authorized(event.sender); return runtime.prerequisite(scope, id); });
  ipcMain.handle("preview-devices:stop", (event, input: { storyId: string; destroy?: boolean }) => { authorized(event.sender); return runtime.service.stop(input.storyId, input.destroy === true); });
}
