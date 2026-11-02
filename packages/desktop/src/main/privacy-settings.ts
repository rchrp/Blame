import { app, ipcMain } from "electron";
import { join } from "node:path";
import { desktopAppIdentity } from "./desktop-app-identity";
import {
  loadPrivacyPreferences,
  parsePrivacyPreferences,
  savePrivacyPreferences,
  type PrivacyPreferences,
} from "./privacy-preferences";

let current: PrivacyPreferences | undefined;

// The userData directory, known before index.ts sets it: telemetry starts first.
function preferencesDirectory() {
  return join(app.getPath("appData"), desktopAppIdentity(app.isPackaged).appId);
}

export function privacyPreferences() {
  current ??= loadPrivacyPreferences(preferencesDirectory());
  return current;
}

// Turning telemetry off stops exports right away; turning it back on takes
// effect at the next launch, when the telemetry SDK starts again.
export function registerPrivacyIpcHandlers(onTelemetryOff: () => void) {
  ipcMain.handle("privacy:get", () => privacyPreferences());
  ipcMain.handle("privacy:set", (_event, value: unknown) => {
    const next = parsePrivacyPreferences(value);
    savePrivacyPreferences(preferencesDirectory(), next);
    const telemetryTurnedOff =
      privacyPreferences().telemetry && !next.telemetry;
    current = next;
    if (telemetryTurnedOff) onTelemetryOff();
    return next;
  });
}
