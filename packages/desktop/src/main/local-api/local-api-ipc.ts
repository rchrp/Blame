import { ipcMain, type WebContents } from "electron";
import type { LocalApiService } from "./local-api-service";

export function registerLocalApiIpcHandlers(options: {
  isAppWindow(sender: WebContents): boolean;
  service: LocalApiService;
}) {
  ipcMain.handle("local-api:session", (event) => {
    if (!options.isAppWindow(event.sender)) {
      throw new Error("Local API request was rejected.");
    }
    return options.service.session();
  });
}
