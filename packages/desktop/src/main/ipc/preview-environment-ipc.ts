import { ipcMain, type WebContents } from "electron";
import type { SetPreviewVariableInput } from "@blame/agent-runtime";
import {
  describePreviewEnvironment,
  setPreviewVariable,
} from "../preview-environment/environment-view";
import { previewVariablesStore } from "../preview-environment/variables-store";
import { projectDatabaseEvidence } from "../preview-environment/database-evidence";
import { resolveWorkspacePath } from "../workspace-runtime";

// The Variables tab of a story preview: read the resolved environment, set
// or remove a story override or project variable, dismiss an agent request.

export function registerPreviewEnvironmentIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
}) {
  const guard = (sender: WebContents) => {
    if (!input.isAppWindow(sender))
      throw new Error("Preview variables request was rejected");
  };
  ipcMain.handle("preview-environment:describe", (event, value) => {
    guard(event.sender);
    const body = record(value);
    return describePreviewEnvironment({
      worktree: worktree(body),
      databaseMode: databaseMode(body.databaseMode),
    });
  });
  ipcMain.handle("preview-environment:set", async (event, value) => {
    guard(event.sender);
    const body = record(value);
    const scope = body.scope === "project" ? "project" : "story";
    const input: SetPreviewVariableInput = {
      worktree: worktree(body),
      key: text(body.key, "key"),
      scope,
      ...(typeof body.value === "string" ? { value: body.value } : {}),
      ...(typeof body.serviceId === "string" && body.serviceId
        ? { serviceId: body.serviceId }
        : {}),
    };
    await setPreviewVariable(input);
    return true;
  });
  ipcMain.handle("preview-environment:database-evidence", (event, value) => {
    guard(event.sender);
    return projectDatabaseEvidence(text(record(value).root, "root"));
  });
  ipcMain.handle(
    "preview-environment:dismiss-request",
    async (event, value) => {
      guard(event.sender);
      const body = record(value);
      await previewVariablesStore()?.dismissRequest(
        worktree(body),
        text(body.key, "key"),
      );
      return true;
    },
  );
}

function record(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Preview variables request needs a ${name}`);
  return value.trim();
}

function worktree(body: Record<string, unknown>) {
  return resolveWorkspacePath(text(body.worktree, "worktree"));
}

function databaseMode(value: unknown) {
  return value === "compose" || value === "existing" ? value : undefined;
}
