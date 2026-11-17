import { join } from "node:path";
import { app, ipcMain, type WebContents } from "electron";
import { worktreeRepositoryRoot } from "../preview-environment/env-file-sources";
import { useReviewBuildSetting } from "../preview-runtime/local/local-preview-serving";
import { PreviewServingSettings } from "../preview-runtime/preview-serving-settings";

let settings: PreviewServingSettings | undefined;

function previewServingSettings() {
  settings ??= new PreviewServingSettings(
    join(app.getPath("userData"), "preview-serving-settings.json"),
  );
  return settings;
}

export function registerPreviewServingIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
}) {
  useReviewBuildSetting(async (worktree) =>
    previewServingSettings().reviewBuilds(
      await worktreeRepositoryRoot(worktree).catch(() => undefined),
    ),
  );
  ipcMain.handle("preview-serving:get-review-builds", (event, value) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Settings request was rejected");
    return previewServingSettings().reviewBuilds(projectPath(value));
  });
  ipcMain.handle("preview-serving:set-review-builds", (event, value) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Settings request was rejected");
    const body =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    return previewServingSettings().setReviewBuilds(
      projectPath(value) ?? "",
      body.enabled === true,
    );
  });
}

function projectPath(value: unknown) {
  const path =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).projectPath
      : undefined;
  return typeof path === "string" ? path : undefined;
}
