import {
  projectScanResource,
  type ProjectScanLocation,
} from "./project-scan-resource.ts";
import {
  authorizeMcpOAuth,
  BlameAgentRuntime,
  clearMcpOAuth,
  closeClaudeCodeSessions,
  executeLightWorkspaceRequest,
  listMcpOAuthStatuses,
  mcpSettingsPath,
  type AgentEvent,
  type LightCommandCredentials,
  type LightWorkspaceExecutionRequest,
} from "@blame/agent-runtime";
import { createAgentEventCoalescer } from "@blame/agent-runtime/agent-event-coalescer";
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
const events = createAgentEventCoalescer((event) =>
  parentPort.postMessage({ event, kind: "event" }),
);
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
    { emit: (event) => events.push(serializableAgentEvent(event)) },
    {
      mcpSettingsPath: mcpSettingsPath(),
      git: (cwd, args) => hostClient.request<string>("git", { args, cwd }),
      renderWebPage: (input) => hostRequest<{ url: string; html: string }>(hostClient, 'renderWebPage', input),
      openExternalUrl: (url) => {
        void hostClient
          .request("openExternalUrl", { url })
          .catch(() => undefined);
      },
      previewContainerLogs: (input) =>
        hostRequest(hostClient, "previewContainerLogs", input),
      previewEnvironment: (input) =>
        hostRequest(hostClient, "previewEnvironment", {
          ...input,
          signal: undefined,
        }),
      previewSurfaceInfo: (input) => hostRequest(hostClient, "previewSurfaceInfo", { ...input, signal: undefined }),
      previewSurfaceCall: (input) => hostRequest(hostClient, "previewSurfaceCall", input),
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
      commandCredentials: (sessionId) =>
        hostClient.request<LightCommandCredentials>("commandCredentials", {
          sessionId,
        }),
      componentPreview: (input) =>
        hostRequest(hostClient, "componentPreview", input),
      githubMcpTools: (input) =>
        hostRequest(hostClient, "githubMcpTools", {
          ...input,
          signal: undefined,
        }),
      githubMcpCall: (input) => hostRequest(hostClient, "githubMcpCall", input),
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
  // A response follows the events its request produced.
  events.flush();
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
    ...mcpOAuthHandlers(),
    // The packaged AppImage's run_task smoke test, where agents run it.
    "lightWorkspace.execute": (input: unknown) =>
      executeLightWorkspaceRequest(input as LightWorkspaceExecutionRequest),
    "runtime.prewarm": (input: unknown) => runtime.prewarm(input as never),
    "claudeCode.closeSessions": (input: unknown) =>
      closeClaudeCodeSessions(input as string[]),
    shutdown: () => runtime.shutdown(),
  } satisfies Record<AgentRuntimeMethod, RuntimeHandler>;
}

function providerHandlers(runtime: BlameAgentRuntime) {
  return {
  };
}

// The main process keeps the MCP settings file; the Cline SDK reads and
// writes its OAuth state here, where it is loaded.
function mcpOAuthHandlers() {
  return {
    "mcpOAuth.statuses": (input: unknown) =>
      listMcpOAuthStatuses(mcpOAuthInput(input).filePath),
    "mcpOAuth.authorize": async (input: unknown) => {
      const { filePath, serverName } = mcpOAuthInput(input);
      await authorizeMcpOAuth({
        filePath,
        serverName,
        openUrl: async (url) => {
          await host.request("openExternalUrl", {
            url: mcpAuthorizationUrl(url),
          });
        },
      });
    },
    "mcpOAuth.clear": (input: unknown) => {
      const { filePath, serverName } = mcpOAuthInput(input);
      clearMcpOAuth(filePath, serverName);
    },
  };
}

function mcpOAuthInput(input: unknown) {
  return input as { filePath: string; serverName: string };
}

function mcpAuthorizationUrl(value: string) {
  const url = new URL(value);
  const loopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]");
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !loopbackHttp)
  ) {
    throw new Error("The MCP server returned an unsafe authorization URL");
  }
  return url.toString();
}

function sessionHandlers(runtime: BlameAgentRuntime) {
  return {
    "sessions.releaseWorkspace": (input: unknown) =>
      runtime.sessions.releaseWorkspace(input as string),
  };
}

function workflowHandlers(runtime: BlameAgentRuntime) {
  return {
    "securityAudits.map": (input: unknown) =>
      runtime.securityAudits.map(input as never),
    pullRequestAvailability: (input: unknown) =>
      runtime.pullRequestAvailability(input as never),
    pullRequestState: (input: unknown) =>
      runtime.pullRequestState(input as never),
    directStoryFiles: (input: unknown) =>
      runtime.directStoryFiles(input as never),
  };
}
