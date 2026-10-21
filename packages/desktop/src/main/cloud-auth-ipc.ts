import type { WebContents } from "electron";
import { ipcMain } from "electron";
import { CloudAuthCookieJar, sendCloudAuthRequest } from "./cloud-auth-request";

type CloudAuthIpcOptions = {
  isAppWindow(sender: WebContents): boolean;
  packaged: boolean;
};

export function registerCloudAuthIpcHandlers(options: CloudAuthIpcOptions) {
  const cookieJar = new CloudAuthCookieJar();
  ipcMain.handle("cloud-auth:request", (event, request) => {
    if (!options.isAppWindow(event.sender)) {
      throw new Error("Cloud authentication request was rejected.");
    }
    return sendCloudAuthRequest(request, {
      cookieJar,
      packaged: options.packaged,
    });
  });
}
