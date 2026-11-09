import { app, ipcMain } from "electron";
import {
  loadPrivacyPreferences,
  parsePrivacyPreferences,
  savePrivacyPreferences,
  type PrivacyPreferences,
} from "./privacy-preferences";

let current: PrivacyPreferences | undefined;

export function privacyPreferences() {
  current ??= loadPrivacyPreferences(app.getPath("userData"));
  return current;
}

export function registerPrivacyIpcHandlers() {
  ipcMain.handle("privacy:get", () => privacyPreferences());
  ipcMain.handle("privacy:set", (_event, value: unknown) => {
    current = parsePrivacyPreferences(value);
    savePrivacyPreferences(app.getPath("userData"), current);
    return current;
  });
}
