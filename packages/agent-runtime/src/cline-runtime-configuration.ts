import { basename } from "node:path";

import { fileURLToPath } from "node:url";

import type {
  ClineCoreOptions,
  RemoteOptions as ClineRemoteOptions,
} from "@cline/sdk";


import {
  legacyDirectWorkspaceTools,
  readTools,
  writeTools,
} from "./cline-tool-policy.js";

import { createProductionLogger } from "./production.js";

import type {
  AgentBackendConfig,
  StartSessionInput,
} from "./types.js";

export const productionLogger = createProductionLogger();

export function toolPolicies(
  autoApproveWriteTools: boolean,
  additionalAutoApprovedTools: string[] = [],
) {
  return Object.fromEntries([
    ["web_search", { enabled: false, autoApprove: false }],
    ["fetch_web_content", { enabled: false, autoApprove: false }],
    ...legacyDirectWorkspaceTools.map((name) => [
      name,
      { enabled: false, autoApprove: false },
    ]),
    ...readTools.map((name) => [name, { autoApprove: true }]),
    ...additionalAutoApprovedTools.map((name) => [name, { autoApprove: true }]),
    ...writeTools.map((name) => [name, { autoApprove: autoApproveWriteTools }]),
  ]);
}

export function clineDefaultToolPolicies() {
  return Object.fromEntries([
    ["*", { autoApprove: true }],
    ["web_search", { enabled: false, autoApprove: false }],
    ["fetch_web_content", { enabled: false, autoApprove: false }],
    ...legacyDirectWorkspaceTools.map((name) => [
      name,
      { enabled: true, autoApprove: true },
    ]),
    ["ask_question", { enabled: false, autoApprove: false }],
  ]);
}

export function backendKey(backend?: AgentBackendConfig) {
  if (backend?.key) return backend.key;
  if (!backend) return "local";
  if (backend.mode === "remote") return `remote:${backend.endpoint ?? ""}`;
  if (backend.mode === "hub") return `hub:${backend.endpoint ?? "default"}`;
  return backend.mode;
}

export function coreBackendOptions(
  backend?: AgentBackendConfig,
): ClineCoreOptions {
  if (!backend) return { backendMode: "local" };
  if (backend.mode === "remote") {
    if (!backend.endpoint)
      throw new Error("Remote Cline backend endpoint is required.");
    return {
      backendMode: "remote",
      remote: remoteConnectionOptions(backend, backend.endpoint),
    };
  }
  if (backend.mode === "hub") {
    return {
      backendMode: "hub",
      hub: hubConnectionOptions(backend, backend.endpoint),
    };
  }
  return { backendMode: backend.mode };
}

function remoteConnectionOptions(
  backend: AgentBackendConfig,
  endpoint: string,
): ClineRemoteOptions {
  return {
    endpoint,
    ...(backend.authToken ? { authToken: backend.authToken } : {}),
    ...(backend.cwd ? { cwd: backend.cwd } : {}),
    ...(backend.workspaceRoot ? { workspaceRoot: backend.workspaceRoot } : {}),
    clientType: "blame-desktop",
    displayName: "Blame",
  };
}

function hubConnectionOptions(
  backend: AgentBackendConfig,
  endpoint: string | undefined,
) {
  return {
    ...(endpoint ? { endpoint } : {}),
    ...(backend.authToken ? { authToken: backend.authToken } : {}),
    ...(backend.cwd ? { cwd: backend.cwd } : {}),
    ...(backend.workspaceRoot ? { workspaceRoot: backend.workspaceRoot } : {}),
    clientType: "blame-desktop",
    displayName: "Blame",
  };
}

export function blameNativePluginPath() {
  return fileURLToPath(
    new URL("./plugins/blame-native/index.js", import.meta.url),
  );
}

export function withConfigExtensions(
  extensions: StartSessionInput["configExtensions"],
  ...required: NonNullable<StartSessionInput["configExtensions"]>
) {
  return Array.from(new Set([...(extensions ?? []), ...required]));
}

export function extensionContext(input: StartSessionInput) {
  return {
    client: { name: "blame" },
    logger: productionLogger,
    workspace: {
      cwd: input.cwd,
      ide: "Blame",
      mode: input.mode ?? "act",
      platform: process.platform,
      rootPath: input.workspaceRoot,
      workspaceName: basename(input.workspaceRoot),
    },
  };
}

