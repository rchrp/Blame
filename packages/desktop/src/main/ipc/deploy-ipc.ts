import { ipcMain, type WebContents } from "electron";
import { parsePreviewManifest } from "@blame/preview-contract";
import type { DeployService } from "../deploy/deploy-service.ts";

export function registerDeployIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
  service: DeployService;
}) {
  const owner = (event: Electron.IpcMainInvokeEvent) => {
    if (!input.isAppWindow(event.sender)) {
      throw new Error("Deployment request was rejected");
    }
  };

  ipcMain.handle("deploy:configure", (event, value) => {
    owner(event);
    const body = record(value);
    input.service.configure({
      token: requiredString(body.token, "token", 16_384),
      url: requiredString(body.url, "url", 2_048),
    });
    return true;
  });
  ipcMain.handle("deploy:disconnect", (event) => {
    owner(event);
    input.service.disconnect();
    return true;
  });
  ipcMain.handle("deploy:preflight", (event, value) => {
    owner(event);
    return input.service.preflight(deployInput(value));
  });
  ipcMain.handle("deploy:start", (event, value) => {
    owner(event);
    const body = record(value);
    const operationId = requiredUuid(body.operationId, "operationId");
    const channel = `deploy:progress:${operationId}`;
    return input.service.deploy(
      {
        ...deployInput(body),
        projectId: requiredUuid(body.projectId, "projectId"),
        targetId: requiredUuid(body.targetId, "targetId"),
        operationId,
        expectedWorkspaceHash: requiredHash(body.expectedWorkspaceHash),
      },
      (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, progress);
      },
    );
  });
}

function deployInput(value: unknown) {
  const body = record(value);
  const runConfigurations = body.runConfigurations;
  if (!Array.isArray(runConfigurations) || runConfigurations.length > 100) {
    throw new Error("Deployment run configurations are invalid");
  }
  return {
    root: requiredString(body.root, "root", 8_192),
    previewManifest: parsePreviewManifest(body.previewManifest),
    runConfigurations: runConfigurations.map((value) => {
      const configuration = record(value);
      const category = configuration.category;
      if (
        !["web", "mobile", "desktop", "terminal", "service", "other"].includes(
          String(category),
        )
      ) {
        throw new Error("Deployment run configuration category is invalid");
      }
      return {
        id: requiredString(configuration.id, "id", 128),
        command: requiredString(configuration.command, "command", 1_000),
        cwd: requiredString(configuration.cwd, "cwd", 512),
        default: configuration.default === true,
        category: category as
          | "web"
          | "mobile"
          | "desktop"
          | "terminal"
          | "service"
          | "other",
        services: strings(configuration.services, "services"),
        previewService:
          configuration.previewService === null
            ? null
            : optionalString(
                configuration.previewService,
                "previewService",
                128,
              ),
        scopes: strings(configuration.scopes, "scopes"),
      };
    }),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Deployment request is invalid");
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`Deployment ${field} is invalid`);
  }
  return value.map((item) => requiredString(item, field, 512));
}

function requiredString(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`Deployment ${field} is invalid`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, maximum: number) {
  return value === undefined
    ? undefined
    : requiredString(value, field, maximum);
}

function requiredHash(value: unknown) {
  const hash = requiredString(value, "workspaceHash", 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("Deployment workspace hash is invalid");
  }
  return hash;
}

function requiredUuid(value: unknown, field: string) {
  const id = requiredString(value, field, 36);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      id,
    )
  ) {
    throw new Error(`Deployment ${field} is invalid`);
  }
  return id;
}
