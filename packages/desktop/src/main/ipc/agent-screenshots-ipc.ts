import { writeFile } from "node:fs/promises";
import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import {
  agentScreenshotId,
  isAgentScreenshotId,
  maximumAgentScreenshotBytes,
  type AgentScreenshotMetadata,
} from "../agent-screenshots/agent-screenshot-store";
import { agentScreenshotStore } from "../agent-screenshots/agent-screenshots-service";

// Read-only access to the agent's screenshots for the app. Caching a copy
// fetched from the account is the only write, and it must match its id.

const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export function registerAgentScreenshotIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
}) {
  const owner = (event: IpcMainInvokeEvent) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Screenshot request was rejected");
  };
  ipcMain.handle("agent-screenshots:read", async (event, value) => {
    owner(event);
    const body = record(value);
    const id = screenshotId(body.id);
    const scopes = optionalStrings(body.scopes);
    const stored = await agentScreenshotStore().read(id);
    if (!stored) return null;
    if (scopes && !scopes.includes(stored.metadata.scope)) return null;
    return {
      dataUrl: `data:${stored.metadata.mimeType};base64,${stored.data.toString("base64")}`,
      metadata: stored.metadata,
    };
  });
  ipcMain.handle("agent-screenshots:list", (event, value) => {
    owner(event);
    const body = record(value);
    return agentScreenshotStore().list({
      runId: optionalString(body.runId),
      scope: optionalString(body.scope),
      sessionId: optionalString(body.sessionId),
    });
  });
  ipcMain.handle("agent-screenshots:cache", async (event, value) => {
    owner(event);
    const body = record(value);
    const id = screenshotId(body.id);
    const metadata = record(body.metadata);
    const { data, mimeType } = decodeDataUrl(body.dataUrl);
    if (agentScreenshotId(data) !== id)
      throw new Error("The screenshot does not match its id.");
    const saved = await agentScreenshotStore().save({
      colorScheme: metadata.colorScheme === "dark" ? "dark" : "light",
      data,
      height: positive(metadata.height),
      mimeType,
      pageUrl: optionalString(metadata.pageUrl) ?? "",
      scope: requiredString(metadata.scope, "scope"),
      ...(optionalString(metadata.sessionId)
        ? { sessionId: optionalString(metadata.sessionId) }
        : {}),
      viewport: {
        height: positive(record(metadata.viewport).height ?? metadata.height),
        width: positive(record(metadata.viewport).width ?? metadata.width),
      },
      width: positive(metadata.width),
    });
    return saved satisfies AgentScreenshotMetadata;
  });
  ipcMain.handle("agent-screenshots:copy", async (event, value) => {
    owner(event);
    const stored = await agentScreenshotStore().read(
      screenshotId(record(value).id),
    );
    if (!stored) return false;
    clipboard.writeImage(nativeImage.createFromBuffer(stored.data));
    return true;
  });
  ipcMain.handle("agent-screenshots:save-as", async (event, value) => {
    owner(event);
    const stored = await agentScreenshotStore().read(
      screenshotId(record(value).id),
    );
    if (!stored) return false;
    const extension = stored.metadata.mimeType.split("/")[1] ?? "png";
    const options = {
      defaultPath: `screenshot-${stored.metadata.id.slice(0, 8)}.${extension === "jpeg" ? "jpg" : extension}`,
      filters: [
        {
          extensions: [extension === "jpeg" ? "jpg" : extension],
          name: "Image",
        },
      ],
    };
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, stored.data);
    return true;
  });
  ipcMain.handle("agent-screenshots:delete", async (event, value) => {
    owner(event);
    const body = record(value);
    const scope = optionalString(body.scope);
    if (scope) await agentScreenshotStore().deleteScope(scope);
    const sessionIds = optionalStrings(body.sessionIds);
    if (sessionIds) await agentScreenshotStore().deleteSessions(sessionIds);
    return true;
  });
}

function decodeDataUrl(value: unknown) {
  const match =
    typeof value === "string"
      ? value.match(
          /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/u,
        )
      : null;
  if (!match || !imageTypes.has(match[1]))
    throw new Error("The screenshot data is invalid.");
  const data = Buffer.from(match[2], "base64");
  if (!data.byteLength || data.byteLength > maximumAgentScreenshotBytes)
    throw new Error("The screenshot data is invalid.");
  return { data, mimeType: match[1] };
}

function screenshotId(value: unknown) {
  if (!isAgentScreenshotId(value)) throw new Error("Invalid screenshot id.");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() && value.length <= 4_096
    ? value
    : undefined;
}

function requiredString(value: unknown, label: string) {
  const result = optionalString(value);
  if (!result) throw new Error(`Screenshot ${label} is required.`);
  return result;
}

function optionalStrings(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => Boolean(optionalString(item)));
}

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 1;
}
