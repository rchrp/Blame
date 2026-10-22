import { randomUUID } from "node:crypto";

export const agentRuntimeMethods = [
  "runtime.prewarm",
  "providers.list",
  "providers.saveCredential",
  "providers.deleteCredential",
  "providers.loginOAuth",
  "providers.claudeCodeStatus",
  "providers.connectClaudeCode",
  "providers.subscriptionUsage",
  "sessions.start",
  "sessions.startDevelopment",
  "sessions.send",
  "sessions.sendDevelopment",
  "sessions.abort",
  "sessions.compareCheckpoint",
  "sessions.list",
  "sessions.messages",
  "sessions.restoreCheckpoint",
  "sessions.usage",
  "sessions.compact",
  "sessions.releaseWorkspace",
  "approvals.resolve",
  "initializations.run",
  "initializations.repair",
  "initializations.assessImpact",
  "codePractices.run",
  "securityAudits.map",
  "securityAudits.discover",
  "securityAudits.validate",
  "securityAudits.cancel",
  "securityAudits.finish",
  "newProjects.generate",
  "promptOptimizer.optimizeUserStory",
  "promptOptimizer.generateTitle",
  "approveAndMerge",
  "generateCommitMessage",
  "resolveMergeConflicts",
  "telemetry.configure",
  "telemetry.disable",
  "shutdown",
] as const;

export const agentHostMethods = [
  "git",
  "openExternalUrl",
  "previewDevtools",
  "previewDevtoolsCall",
  "previewScreenshotKnown",
  "previewDevtoolsTools",
  "previewContainerLogs",
  "refreshPreviewDependencies",
  "applyPreviewInitialization",
  "lightWorkspace",
] as const;

export type AgentRuntimeMethod = (typeof agentRuntimeMethods)[number];
export type AgentHostMethod = (typeof agentHostMethods)[number];
export type AgentRpcTarget = "host" | "runtime";

export type AgentRpcError = {
  code?: string;
  message: string;
  name: string;
};

export type AgentRpcRequest = {
  id: string;
  input?: unknown;
  kind: "request";
  method: AgentHostMethod | AgentRuntimeMethod;
  target: AgentRpcTarget;
};

export type AgentRpcResponse = {
  error?: AgentRpcError;
  id: string;
  kind: "response";
  result?: unknown;
  target: AgentRpcTarget;
};

export type AgentRpcCancel = {
  id: string;
  kind: "cancel";
  target: AgentRpcTarget;
};

export type AgentRuntimeEventMessage = {
  event: unknown;
  kind: "event";
};

export type AgentRuntimeReadyMessage = {
  kind: "ready";
};

export type AgentProcessMessage =
  | AgentRpcCancel
  | AgentRpcRequest
  | AgentRpcResponse
  | AgentRuntimeEventMessage
  | AgentRuntimeReadyMessage;

export function agentRpcRequest(
  target: AgentRpcTarget,
  method: AgentHostMethod | AgentRuntimeMethod,
  input?: unknown,
): AgentRpcRequest {
  return {
    id: randomUUID(),
    input,
    kind: "request",
    method,
    target,
  };
}

export function agentRpcError(error: unknown): AgentRpcError {
  const name = error instanceof Error ? error.name : "Error";
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...(code ? { code } : {}),
    message:
      message.trim() ||
      (name === "HubTransportError"
        ? `Unable to connect to the agent hub (${code ?? name}).`
        : `Agent request failed (${code ?? name}).`),
    name,
  };
}

export function agentRpcResponseError(error: AgentRpcError) {
  const next = new Error(error.message);
  next.name = error.name;
  return Object.assign(next, error.code ? { code: error.code } : {});
}

export function isAgentProcessMessage(
  value: unknown,
): value is AgentProcessMessage {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return ["cancel", "event", "ready", "request", "response"].includes(
    String(kind),
  );
}
