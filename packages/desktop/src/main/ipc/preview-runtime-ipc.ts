import { BrowserWindow, ipcMain, type WebContents } from "electron";
import type { PreviewSessionCommand } from "@blame/preview-runtime";
import { isRuntimeProfileId } from "@blame/preview-runtime";
import type { PreviewService } from "../preview-runtime/preview-service";
import { isCloudPreviewSessionId } from "../preview-runtime/cloud-preview-client";

export function registerPreviewRuntimeIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
  service: PreviewService;
}) {
  const subscriptions = new Map<string, AbortController>();
  const owner = (event: Electron.IpcMainInvokeEvent) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Preview request was rejected");
  };
  const connectionOwner = (event: Electron.IpcMainInvokeEvent) => {
    if (input.isAppWindow(event.sender)) return;
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Preview request was rejected");
    }
  };

  ipcMain.handle("preview-runtime:configure", (event, value) => {
    // Window presentation replaces the compact window with the workspace
    // window. An in-flight, idempotent connection setup from that trusted
    // outgoing top-level window may finish after the replacement starts.
    connectionOwner(event);
    const body = record(value);
    input.service.configureCloud({
      token: requiredString(body.token, "token", 16_384),
      url: requiredString(body.url, "url", 2_048),
    });
    return true;
  });
  ipcMain.handle("preview-runtime:disconnect", (event) => {
    owner(event);
    for (const controller of subscriptions.values()) controller.abort();
    subscriptions.clear();
    input.service.clearCloud();
    return true;
  });
  ipcMain.handle("preview-runtime:create", (event, value) => {
    owner(event);
    const body = record(value);
    if (
      !isRuntimeProfileId(body.profile) ||
      body.profile === "local-container"
    ) {
      throw new Error("Managed preview profile is invalid");
    }
    return input.service.create({
      userStoryId: requiredString(body.userStoryId, "userStoryId", 128),
      profile: body.profile,
      previewManifest: record(body.previewManifest),
      cloudUploadConsentAt: requiredIsoDate(body.cloudUploadConsentAt),
      operationId: requiredString(body.operationId, "operationId", 80),
      localPath: requiredString(body.localPath, "localPath", 8_192),
      sourceRevision: optionalString(
        body.sourceRevision,
        "sourceRevision",
        128,
      ),
      resourceSize: optionalResourceSize(body.resourceSize),
    });
  });
  ipcMain.handle("preview-runtime:get", (event, value) => {
    owner(event);
    return input.service.get(requiredSessionId(record(value).sessionId));
  });
  ipcMain.handle("preview-runtime:find-for-story", (event, value) => {
    owner(event);
    const body = record(value);
    if (body.profile !== "vercel-compose")
      throw new Error("Managed preview profile is invalid");
    return input.service.findForUserStory(
      requiredString(body.userStoryId, "userStoryId", 128),
      body.profile,
    );
  });
  ipcMain.handle("preview-runtime:open-external", (event, value) => {
    owner(event);
    const body = record(value);
    return input.service.openExternal(
      requiredSessionId(body.sessionId),
      optionalString(body.routeId, "routeId", 128),
    );
  });
  ipcMain.handle("preview-runtime:command", (event, value) => {
    owner(event);
    const body = record(value);
    return input.service.command(
      requiredSessionId(body.sessionId),
      previewCommand(body.command),
      requiredString(body.operationId, "operationId", 128),
    );
  });
  ipcMain.handle("preview-runtime:sync-in", (event, value) => {
    owner(event);
    const body = record(value);
    return input.service.syncInitial(
      requiredSessionId(body.sessionId),
      requiredString(body.localPath, "localPath", 8_192),
    );
  });
  ipcMain.handle("preview-runtime:sync-out", (event, value) => {
    owner(event);
    const body = record(value);
    return input.service.syncBack(
      requiredSessionId(body.sessionId),
      optionalString(body.localPath, "localPath", 8_192),
    );
  });
  ipcMain.handle("preview-runtime:subscribe", (event, value) => {
    owner(event);
    const body = record(value);
    const sessionId = requiredSessionId(body.sessionId);
    const subscriptionId = requiredString(
      body.subscriptionId,
      "subscriptionId",
      128,
    );
    const cursor = optionalString(body.cursor, "cursor", 128);
    subscriptions.get(subscriptionId)?.abort();
    const controller = new AbortController();
    subscriptions.set(subscriptionId, controller);
    const abortWhenSenderCloses = () => controller.abort();
    event.sender.once("destroyed", abortWhenSenderCloses);
    void pumpEvents(
      input.service,
      event.sender,
      sessionId,
      subscriptionId,
      cursor,
      controller,
    ).finally(() => {
      event.sender.removeListener("destroyed", abortWhenSenderCloses);
      if (subscriptions.get(subscriptionId) === controller) {
        subscriptions.delete(subscriptionId);
      }
    });
    return true;
  });
  ipcMain.handle("preview-runtime:subscribe-logs", (event, value) => {
    owner(event);
    const body = record(value);
    const sessionId = requiredSessionId(body.sessionId);
    const subscriptionId = requiredString(
      body.subscriptionId,
      "subscriptionId",
      128,
    );
    const cursor = optionalString(body.cursor, "cursor", 128);
    subscriptions.get(subscriptionId)?.abort();
    const controller = new AbortController();
    subscriptions.set(subscriptionId, controller);
    const abortWhenSenderCloses = () => controller.abort();
    event.sender.once("destroyed", abortWhenSenderCloses);
    void pumpLogs(
      input.service,
      event.sender,
      sessionId,
      subscriptionId,
      cursor,
      controller,
    ).finally(() => {
      event.sender.removeListener("destroyed", abortWhenSenderCloses);
      if (subscriptions.get(subscriptionId) === controller) {
        subscriptions.delete(subscriptionId);
      }
    });
    return true;
  });
  ipcMain.handle("preview-runtime:unsubscribe", (event, value) => {
    owner(event);
    const subscriptionId = requiredString(
      record(value).subscriptionId,
      "subscriptionId",
      128,
    );
    subscriptions.get(subscriptionId)?.abort();
    subscriptions.delete(subscriptionId);
    return true;
  });
}
async function pumpLogs(
  service: PreviewService,
  sender: Electron.WebContents,
  sessionId: string,
  subscriptionId: string,
  cursor: string | undefined,
  controller: AbortController,
) {
  try {
    for await (const event of service.logs(
      sessionId,
      cursor,
      controller.signal,
    )) {
      if (controller.signal.aborted || sender.isDestroyed()) break;
      sender.send(`preview-runtime:log:${subscriptionId}`, event);
    }
  } catch (error) {
    if (!controller.signal.aborted && !sender.isDestroyed()) {
      sender.send(`preview-runtime:error:${subscriptionId}`, safeError(error));
    }
  }
}

async function pumpEvents(
  service: PreviewService,
  sender: Electron.WebContents,
  sessionId: string,
  subscriptionId: string,
  cursor: string | undefined,
  controller: AbortController,
) {
  try {
    for await (const event of service.events(
      sessionId,
      cursor,
      controller.signal,
    )) {
      if (controller.signal.aborted || sender.isDestroyed()) break;
      sender.send(`preview-runtime:event:${subscriptionId}`, event);
    }
  } catch (error) {
    if (!controller.signal.aborted && !sender.isDestroyed()) {
      sender.send(`preview-runtime:error:${subscriptionId}`, safeError(error));
    }
  }
}

function previewCommand(value: unknown): PreviewSessionCommand {
  const body = record(value);
  switch (body.type) {
    case "start-services":
      return {
        type: body.type,
        configurationId: requiredString(
          body.configurationId,
          "configurationId",
          128,
        ),
        serviceIds: optionalServiceIds(body.serviceIds),
        primaryRoute: optionalPrimaryRoute(body.primaryRoute),
      };
    case "stop-services":
    case "start-agent":
    case "stop-agent":
    case "suspend-host":
    case "resume-host":
    case "report-sync-conflict":
      return { type: body.type };
    case "ack-local-sync":
      return {
        type: body.type,
        deltaRevision: requiredString(body.deltaRevision, "deltaRevision", 128),
        workspaceHash: requiredHash(body.workspaceHash, "workspaceHash"),
      };
    case "destroy-host": {
      const discard =
        body.discardPendingDelta === undefined
          ? undefined
          : record(body.discardPendingDelta);
      return {
        type: body.type,
        discardPendingDelta: discard
          ? {
              confirmationId: requiredString(
                discard.confirmationId,
                "confirmationId",
                128,
              ),
            }
          : undefined,
      };
    }
    default:
      throw new Error("Preview command is invalid");
  }
}

function optionalServiceIds(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50)
    throw new Error("Preview service selection is invalid");
  return [
    ...new Set(value.map((entry) => requiredString(entry, "serviceId", 128))),
  ];
}

function optionalPrimaryRoute(value: unknown) {
  if (value === undefined) return undefined;
  const route = record(value);
  return {
    serviceId: requiredString(route.serviceId, "primaryRoute.serviceId", 80),
    endpointId: requiredString(route.endpointId, "primaryRoute.endpointId", 80),
  };
}

function optionalResourceSize(value: unknown) {
  if (value === undefined) return undefined;
  const body = record(value);
  const vcpus = Number(body.vcpus);
  const memoryGb = Number(body.memoryGb);
  if (
    !Number.isSafeInteger(vcpus) ||
    !Number.isSafeInteger(memoryGb) ||
    vcpus < 1 ||
    memoryGb < 1
  ) {
    throw new Error("Preview resource size is invalid");
  }
  return { vcpus, memoryGb };
}

function requiredSessionId(value: unknown) {
  if (!isCloudPreviewSessionId(value))
    throw new Error("Preview session ID is invalid");
  return value;
}

function requiredIsoDate(value: unknown) {
  const result = requiredString(value, "cloudUploadConsentAt", 64);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error("Cloud upload consent timestamp is invalid");
  return result;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Preview input is invalid");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error(`${name} is invalid`);
  return value;
}

function optionalString(value: unknown, name: string, maximum: number) {
  return value === undefined ? undefined : requiredString(value, name, maximum);
}

function requiredHash(value: unknown, name: string) {
  const result = requiredString(value, name, 64);
  if (!/^[a-f0-9]{64}$/i.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function safeError(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "Preview event stream failed";
}
