import { join } from "node:path";
import { app, ipcMain, type WebContents } from "electron";
import { PreviewDevtoolsSettings } from "../preview-runtime/preview-devtools-settings";

let settings: PreviewDevtoolsSettings | undefined;

export function previewDevtoolsSettings() {
  settings ??= new PreviewDevtoolsSettings(
    join(app.getPath("userData"), "preview-devtools-settings.json"),
  );
  return settings;
}

export function registerPreviewDevtoolsSettingsIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
}) {
  ipcMain.handle("preview-devtools:get-advanced", (event, value) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Settings request was rejected");
    return previewDevtoolsSettings().advancedDiagnostics(projectId(value));
  });
  ipcMain.handle("preview-devtools:set-advanced", (event, value) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Settings request was rejected");
    const body =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    return previewDevtoolsSettings().setAdvancedDiagnostics(
      projectId(value) ?? "",
      body.enabled === true,
    );
  });
}

function projectId(value: unknown) {
  const id =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).projectId
      : undefined;
  return typeof id === "string" ? id : undefined;
}
