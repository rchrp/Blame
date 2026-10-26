import {
  projectScanResource,
  type ProjectScanLocation,
} from "./project-scan-resource.ts";
import {
  BlameAgentRuntime,
  type AgentEvent,
  type LightWorkspaceExecutionRequest,
} from "@blame/agent-runtime";
import {
  configureDesktopTelemetry,
  disableDesktopTelemetry,
} from "./desktop-telemetry.ts";
import { AgentRuntimeHostClient } from "./agent-runtime-host-client.ts";
import {
  agentRpcError,
  isAgentProcessMessage,
  type AgentHostMethod,
  type AgentRpcRequest,
  type AgentRuntimeMethod,
} from "./agent-runtime-process-protocol.ts";

type RuntimeHandler = (input: unknown) => Promise<unknown> | unknown;

type PreviewDevtoolsTarget = {
  available: boolean;
  currentUrl?: string;
  error?: string;
  id?: string;
  loading: boolean;
  message: string;
  reason: string;
  scope?: string;
  status: "failed" | "ready" | "starting" | "stopped" | "unavailable";
};

const parentPort = process.parentPort;
if (!parentPort) throw new Error("Agent runtime parent port is unavailable");

const host = new AgentRuntimeHostClient(parentPort);
const runtime = createAgentRuntime(host);
const handlers = runtimeHandlers(runtime);

parentPort.on("message", ({ data }) => {
  if (!isAgentProcessMessage(data)) return;
  if (data.kind === "response" && data.target === "host") {
    host.resolve(data);
    return;
  }
  if (data.kind === "request" && data.target === "runtime") {
    void handleRuntimeRequest(data);
  }
});

parentPort.postMessage({ kind: "ready" });

function createAgentRuntime(hostClient: AgentRuntimeHostClient) {
  return new BlameAgentRuntime(
    {
      emit: (event) =>
        parentPort.postMessage({
          event: serializableAgentEvent(event),
          kind: "event",
        }),
    },
    {
      git: (cwd, args) => hostClient.request<string>("git", { args, cwd }),
      renderWebPage: (input) => hostRequest<{ url: string; html: string }>(hostClient, 'renderWebPage', input),
      openExternalUrl: (url) => {
        void hostClient
          .request("openExternalUrl", { url })
          .catch(() => undefined);
      },
      previewContainerLogs: (input) =>
        hostRequest(hostClient, "previewContainerLogs", input),
      previewDevtools: (input) =>
        hostRequest<PreviewDevtoolsTarget | undefined>(
          hostClient,
          "previewDevtools",
          input ?? {},
        ),
      previewDevtoolsCall: (input) =>
        hostRequest(hostClient, "previewDevtoolsCall", input),
      previewScreenshotKnown: (input) =>
        hostRequest<boolean>(hostClient, "previewScreenshotKnown", {
          ...input,
          signal: undefined,
        }),
      previewDevtoolsTools: (input) =>
        hostRequest(hostClient, "previewDevtoolsTools", input),
      refreshPreviewDependencies: (input) =>
        hostRequest(hostClient, "refreshPreviewDependencies", input),
      applyPreviewInitialization: (input) =>
        hostRequest(hostClient, "applyPreviewInitialization", {
          ...input,
          signal: undefined,
        }),
      projectApp: (input) => hostRequest(hostClient, "projectApp", input),
      projectScanRoot: async (workspace) => {
        const request = { workspace, signal: undefined };
        const location = await hostRequest<ProjectScanLocation>(
          hostClient,
          "projectScanRoot",
          request,
        );
        return projectScanResource(location);
      },
      ...(process.platform === "darwin" || process.platform === "win32"
        ? {
            lightWorkspace: (
              input: LightWorkspaceExecutionRequest,
              signal?: AbortSignal,
            ) =>
              hostRequest(hostClient, "lightWorkspace", {
                ...input,
                signal,
              }),
          }
        : {}),
    },
  );
}

function serializableAgentEvent(event: AgentEvent): AgentEvent {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || !("raw" in payload)) {
    return event;
  }
  const { raw, ...serializablePayload } = payload as Record<string, unknown>;
  void raw;
  return { ...event, payload: serializablePayload };
}

function hostRequest<Result>(
  hostClient: AgentRuntimeHostClient,
  method: AgentHostMethod,
  input: { signal?: AbortSignal },
) {
  return hostClient.request<Result>(
    method,
    serializableHostInput(input),
    input.signal,
  );
}

function serializableHostInput(input: { signal?: AbortSignal }) {
  const { signal, ...serializable } = input;
  void signal;
  return serializable;
}

async function handleRuntimeRequest(request: AgentRpcRequest) {
  const handler = handlers[request.method as AgentRuntimeMethod];
  if (!handler) {
    respond(request, undefined, new Error("Unknown agent runtime method"));
    return;
  }
  try {
    respond(request, await handler(request.input));
  } catch (error) {
    respond(request, undefined, error);
  }
}

function respond(request: AgentRpcRequest, result?: unknown, error?: unknown) {
  parentPort.postMessage({
    ...(error ? { error: agentRpcError(error) } : { result }),
    id: request.id,
    kind: "response",
    target: "runtime",
  });
}

function runtimeHandlers(runtime: BlameAgentRuntime) {
  return {
    ...providerHandlers(runtime),
    ...sessionHandlers(runtime),
    ...workflowHandlers(runtime),
    "runtime.prewarm": (input: unknown) => runtime.prewarm(input as never),
    "approvals.resolve": (input) => runtime.approvals.resolve(input as never),
    "telemetry.configure": (input) => configureDesktopTelemetry(input),
    "telemetry.disable": () => disableDesktopTelemetry(),
    shutdown: () => runtime.shutdown(),
  } satisfies Record<AgentRuntimeMethod, RuntimeHandler>;
}

function providerHandlers(runtime: BlameAgentRuntime) {
  return {
    "providers.list": (input: unknown) =>
      runtime.providers.list(input as never),
    "providers.saveCredential": (input: unknown) => {
      const [connection, credential] = input as [never, never];
      return runtime.providers.saveCredential(connection, credential);
    },
    "providers.deleteCredential": (input: unknown) => {
      const [connection, id] = input as [never, string];
      return runtime.providers.deleteCredential(connection, id);
    },
    "providers.loginOAuth": (input: unknown) =>
      runtime.providers.loginOAuth(input as never),
    "providers.claudeCodeStatus": () => runtime.providers.claudeCodeStatus(),
    "providers.connectClaudeCode": (input: unknown) =>
      runtime.providers.connectClaudeCode(input as never),
    "providers.subscriptionUsage": (input: unknown) =>
      runtime.providers.subscriptionUsage(input as never),
  };
}

function sessionHandlers(runtime: BlameAgentRuntime) {
  return {
    "sessions.start": (input: unknown) =>
      runtime.sessions.start(input as never),
    "sessions.startDevelopment": (input: unknown) =>
      runtime.sessions.startDevelopment(input as never),
    "sessions.send": (input: unknown) => runtime.sessions.send(input as never),
    "sessions.sendDevelopment": (input: unknown) =>
      runtime.sessions.sendDevelopment(input as never),
    "sessions.abort": (input: unknown) =>
      runtime.sessions.abort(input as string),
    "sessions.compareCheckpoint": (input: unknown) =>
      runtime.sessions.compareCheckpoint(input as never),
    "sessions.list": () => runtime.sessions.list(),
    "sessions.messages": (input: unknown) =>
      runtime.sessions.messages(input as string),
    "sessions.restoreCheckpoint": (input: unknown) =>
      runtime.sessions.restoreCheckpoint(input as never),
    "sessions.usage": (input: unknown) =>
      runtime.sessions.usage(input as string),
    "sessions.compact": (input: unknown) =>
      runtime.sessions.compact(input as never),
    "sessions.releaseWorkspace": (input: unknown) =>
      runtime.sessions.releaseWorkspace(input as string),
  };
}

function workflowHandlers(runtime: BlameAgentRuntime) {
  return {
    "initializations.run": (input: unknown) =>
      runtime.initializations.run(input as never),
    "initializations.repair": (input: unknown) =>
      runtime.initializations.repair(input as never),
    "initializations.assessImpact": (input: unknown) =>
      runtime.initializations.assessImpact(input as never),
    "codePractices.run": (input: unknown) =>
      runtime.codePractices.run(input as never),
    "securityAudits.map": (input: unknown) =>
      runtime.securityAudits.map(input as never),
    "securityAudits.discover": (input: unknown) =>
      runtime.securityAudits.discover(input as never),
    "securityAudits.validate": (input: unknown) =>
      runtime.securityAudits.validate(input as never),
    "securityAudits.cancel": (input: unknown) =>
      runtime.securityAudits.cancel(input as string),
    "securityAudits.finish": (input: unknown) =>
      runtime.securityAudits.finish(input as string),
    "newProjects.plan": (input: unknown) =>
      runtime.newProjects.plan(input as never),
    "newProjects.generate": (input: unknown) =>
      runtime.newProjects.generate(input as never),
    "promptOptimizer.optimizeUserStory": (input: unknown) =>
      runtime.promptOptimizer.optimizeUserStory(input as never),
    "promptOptimizer.generateTitle": (input: unknown) =>
      runtime.promptOptimizer.generateTitle(input as never),
    "planning.reply": (input: unknown) =>
      runtime.planning.reply(input as never),
    approveAndMerge: (input: unknown) =>
      runtime.approveAndMerge(input as never),
    generateCommitMessage: (input: unknown) =>
      runtime.generateCommitMessage(input as never),
    resolveMergeConflicts: (input: unknown) =>
      runtime.resolveMergeConflicts(input as never),
  };
}
