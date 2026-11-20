import { basename } from "node:path";

import { fileURLToPath } from "node:url";

import type {
  ClineCoreOptions,
  RemoteOptions as ClineRemoteOptions,
} from "@cline/sdk";

import { developmentPracticePrompt } from "./cline-runtime-prompts.js";

import {
  initializationFallbackReadTools,
  legacyDirectWorkspaceTools,
  readTools,
  writeTools,
} from "./cline-tool-policy.js";

import {
  appendProductionConfig,
  createProductionLogger,
} from "./production.js";

import { loadPrompt } from "./prompt-loader.js";

import { reasoningConfig } from "./reasoning.js";

import type {
  AgentBackendConfig,
  ApproveAndMergeInput,
  GenerateCommitMessageInput,
  ResolveMergeConflictsInput,
  StartSessionInput,
} from "./types.js";

export const productionLogger = createProductionLogger();

export type MergeConflictRuntimeInput =
  | ApproveAndMergeInput
  | ResolveMergeConflictsInput;

export type CommitMessageRuntimeInput =
  | ApproveAndMergeInput
  | GenerateCommitMessageInput;

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

export function mergeConflictToolPolicies() {
  return {
    ...Object.fromEntries(
      [...readTools, ...writeTools].map((name) => [
        name,
        { enabled: false, autoApprove: false },
      ]),
    ),
    ...Object.fromEntries(
      legacyDirectWorkspaceTools.map((name) => [
        name,
        { enabled: true, autoApprove: true },
      ]),
    ),
    ask_question: { enabled: false, autoApprove: false },
    skills: { enabled: false, autoApprove: false },
  };
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

export function commitMessageConfig(
  input: CommitMessageRuntimeInput,
  credential: { apiKey: string; baseUrl: string | null },
) {
  return appendProductionConfig({
    providerId: input.providerId,
    modelId: input.modelId,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl ?? undefined,
    ...reasoningConfig(input.reasoningEffort),
    systemPrompt: developmentPracticePrompt(
      input.codePractices ?? [],
      "commit_message_convention",
    ),
    cwd: input.worktree,
    workspaceRoot: input.worktree,
    enableTools: false,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    maxIterations: 4,
  });
}

export function mergeConflictConfig(
  input: MergeConflictRuntimeInput,
  credential: { apiKey: string; baseUrl: string | null },
) {
  return appendProductionConfig({
    providerId: input.providerId,
    modelId: input.modelId,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl ?? undefined,
    ...reasoningConfig(input.reasoningEffort),
    systemPrompt: loadPrompt("merge-conflict-resolution"),
    cwd: input.worktree,
    workspaceRoot: input.worktree,
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    maxIterations: 16,
  });
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

export function initializationToolPolicies() {
  return Object.fromEntries([
    ["fetch_web_content", { enabled: false, autoApprove: false }],
    ["web_search", { enabled: false, autoApprove: false }],
    ["submit_project_initialization", { autoApprove: true }],
    ["submit_project_initialization_repair", { autoApprove: true }],
    ...legacyDirectWorkspaceTools.map((name) => [
      name,
      initializationFallbackReadTools.has(name)
        ? { enabled: true, autoApprove: true }
        : { enabled: false, autoApprove: false },
    ]),
    ...readTools.map((name) => [name, { enabled: false, autoApprove: false }]),
    ...writeTools.map((name) => [name, { enabled: false, autoApprove: false }]),
  ]);
}
