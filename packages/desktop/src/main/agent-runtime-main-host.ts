import { withoutTelemetryEnvironment } from "@blame/telemetry";
import type { LightWorkspaceExecutionRequest } from "@blame/agent-runtime";
import { shell } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentHostMethod } from "./agent-runtime-process-protocol.ts";
import {
  agentPreviewPageState,
  holdAgentPreviewBrowser,
  openPreviewDevtoolsEndpoint,
  reloadPreviewBrowserForScope,
} from "./preview-browser-ipc.ts";
import {
  agentScreenshotStore,
  storePreviewDevtoolsScreenshots,
} from "./agent-screenshots/agent-screenshots-service.ts";
import {
  previewDevtoolsMcpService,
  type PreviewDevtoolsMcpService,
} from "./preview-runtime/preview-devtools-mcp-service.ts";
import { PreviewHarnessService } from "./preview-runtime/preview-harness-service.ts";
import { previewLogService } from "./preview-runtime/preview-log-service.ts";
import type { PreviewService } from "./preview-runtime/preview-service.ts";
import { runtimeAgentClient, runtimeAgentSupported } from "./runtime-agent.ts";
import { lightWorkspaceExecutionTarget } from "./light-workspace-routing.ts";
import {
  ensureRuntimeGitUserIdentity,
  getRuntimeGitIdentity,
  run as runRuntime,
  runtimeManagedPath,
} from "./workspace-runtime.ts";

const execFileAsync = promisify(execFile);

export function createAgentHostRequestHandler(previews: PreviewService) {
  const harness = new PreviewHarnessService(previews);
  return (method: AgentHostMethod, input: unknown, signal: AbortSignal) =>
    handleAgentHostRequest(
      method,
      input,
      signal,
      harness,
      previewDevtoolsMcpService,
      previews,
    );
}

async function handleAgentHostRequest(
  method: AgentHostMethod,
  input: unknown,
  signal: AbortSignal,
  harness: PreviewHarnessService,
  devtools: PreviewDevtoolsMcpService,
  previews: PreviewService,
) {
  if (method === "git") return agentGit(input);
  if (method === "openExternalUrl") return openAgentExternalUrl(input);
  if (method === "previewDevtools") {
    return previewDevtoolsTarget(input, signal, harness, devtools);
  }
  if (method === "previewDevtoolsTools") {
    return devtools.listTools({
      advanced: await advancedDiagnostics(recordInput(input).projectId),
    });
  }
  if (method === "previewDevtoolsCall") {
    return previewDevtoolsCall(input, signal, harness, devtools);
  }
  if (method === "previewScreenshotKnown") return previewScreenshotKnown(input);
  if (method === "previewContainerLogs") {
    return previewContainerLogs(input, signal, harness);
  }
  if (method === "refreshPreviewDependencies") {
    return refreshPreviewDependencies(input, signal, harness, previews);
  }
  if (method === "applyPreviewInitialization") {
    return applyPreviewInitialization(input);
  }
  if (method === "projectScanRoot") return agentProjectScanRoot(input);
  if (method === "lightWorkspace") {
    return agentLightWorkspace(input, signal);
  }
  if (method === "projectApp") return agentProjectApp(input, signal);
  throw new Error(`Unsupported agent host method: ${method}`);
}

// The agent process removes a temporary copy itself once its scan is done.
async function agentProjectScanRoot(input: unknown) {
  const workspace = String(recordInput(input).workspace ?? "");
  const { projectScanRoot } = await import("./runtime-workspace-mirror.ts");
  const { root } = await projectScanRoot(workspace);
  return { root, temporary: root !== workspace };
}

// A story working in the project folder checks or starts the project's
// app through the same runner as the user's header controls.
async function agentProjectApp(input: unknown, signal: AbortSignal) {
  const request = recordInput(input);
  const { projectAppForAgent } = await import("./ipc/project-app-ipc.ts");
  return projectAppForAgent(
    {
      action: request.action === "start" ? "start" : "status",
      projectPath: String(request.worktree ?? ""),
    },
    signal,
  );
}

async function applyPreviewInitialization(input: unknown) {
  const request = recordInput(input);
  if (request.workspaceMode === "cloud-mirror") {
    return { status: "unavailable" as const };
  }
  const { applyProjectPreviewInitialization } =
    await import("./workspace-ipc.ts");
  await applyProjectPreviewInitialization({
    databaseMode: request.databaseMode,
    previewManifest: request.previewManifest,
    reason: request.reason,
    repairSessionId: request.repairSessionId,
    runConfigurations: request.runConfigurations,
    storyId: String(request.storyId ?? "preview-repair"),
    worktree: String(request.worktree ?? ""),
  } as never);
  return { status: "applied" as const };
}

async function refreshPreviewDependencies(
  input: unknown,
  signal: AbortSignal,
  harness: PreviewHarnessService,
  previews: PreviewService,
) {
  const request = recordInput(input);
  const worktree = String(request.worktree ?? "");
  try {
    if (request.workspaceMode === "cloud-mirror") {
      await previews.syncBarrier(worktree);
    } else {
      const { refreshProjectPreviewDependencies } =
        await import("./workspace-ipc.ts");
      const local = await refreshProjectPreviewDependencies(worktree);
      if (local.status === "not_running") return local;
    }
    reloadPreviewBrowserForScope({ scope: String(request.scope ?? "") });
    const state = await harness.target({
      ...request,
      signal,
      waitFor: "ready",
    } as never);
    return dependencyRefreshState(state);
  } catch (error) {
    return {
      diagnostic: error instanceof Error ? error.message : String(error),
      status: "failed" as const,
    };
  }
}

function dependencyRefreshState(
  state: Awaited<ReturnType<PreviewHarnessService["target"]>>,
) {
  if (state.status === "failed")
    return { diagnostic: state.message, status: "failed" as const };
  if (state.status === "stopped") return { status: "not_running" as const };
  if (!dependencyPreviewRuntimeReady(state))
    return { diagnostic: state.message, status: "failed" as const };
  return {
    readiness: state.readiness,
    revisions: state.revisions,
    status: "ready" as const,
  };
}

function dependencyPreviewRuntimeReady(
  state: Awaited<ReturnType<PreviewHarnessService["target"]>>,
) {
  if (state.status === "ready") return true;
  return (
    state.status === "unavailable" &&
    state.readiness.container_ready &&
    state.revisions?.dependencies_ready === true
  );
}

// The agent's browser and its DevTools connection open on the first
// preview_devtools__* call, not when readiness is inspected.
async function previewDevtoolsTarget(
  input: unknown,
  signal: AbortSignal,
  harness: PreviewHarnessService,
  devtools: PreviewDevtoolsMcpService,
) {
  const request = recordInput(input);
  const target = await harness.target({ ...request, signal } as never);
  if (!target.available) devtools.disposeScope(String(request.scope ?? ""));
  return target;
}

async function previewContainerLogs(
  input: unknown,
  signal: AbortSignal,
  harness: PreviewHarnessService,
) {
  const request = { ...recordInput(input), signal } as never;
  const preview = await harness.inspect(request);
  return previewLogService.read(request, preview);
}

async function previewDevtoolsCall(
  input: unknown,
  signal: AbortSignal,
  harness: PreviewHarnessService,
  devtools: PreviewDevtoolsMcpService,
) {
  const request = recordInput(input);
  const preview = await harness.inspect({ ...request, signal } as never);
  if (!preview.available || !preview.currentUrl) {
    devtools.disposeScope(String(request.scope ?? ""));
    return unavailablePreviewDevtoolsResult(preview);
  }
  const scope = String(request.scope ?? "");
  const sessionId = optionalText(request.sessionId);
  if (sessionId && scope.trim())
    holdAgentPreviewBrowser(scope.trim(), sessionId);
  const result = await devtools.call({
    advanced: await advancedDiagnostics(request.projectId),
    arguments: recordInput(request.arguments),
    currentUrl: preview.currentUrl,
    openEndpoint: () => openPreviewDevtoolsEndpoint({ scope }),
    pageIdentity: preview.id,
    previewOrigin: preview.previewOrigin,
    scope,
    signal,
    toolName: String(request.toolName ?? ""),
    worktree: String(request.worktree ?? ""),
  });
  return storePreviewDevtoolsScreenshots(result, {
    page: await agentPreviewPageState(scope),
    runId: optionalText(request.runId),
    scope,
    sessionId: optionalText(request.sessionId),
    toolCallId: optionalText(request.toolCallId),
  });
}

// A screenshot belongs to the conversation when it was taken in the same
// session or for the same preview scope.
async function previewScreenshotKnown(input: unknown) {
  const request = recordInput(input);
  const id = optionalText(request.id);
  if (!id) return false;
  const metadata = await agentScreenshotStore().metadata(id);
  if (!metadata) return false;
  const sessionId = optionalText(request.sessionId);
  const scope = optionalText(request.scope);
  return (
    (Boolean(sessionId) && metadata.sessionId === sessionId) ||
    (Boolean(scope) && metadata.scope === scope)
  );
}

function unavailablePreviewDevtoolsResult(preview: {
  message: string;
  reason: string;
  status: string;
}) {
  return {
    content: [{ type: "text", text: `${preview.message} (${preview.reason})` }],
    isError: true,
    structuredContent: { preview },
  };
}

async function agentLightWorkspace(input: unknown, signal: AbortSignal) {
  const request = input as LightWorkspaceExecutionRequest;
  if (
    !runtimeAgentSupported() ||
    !request ||
    typeof request !== "object" ||
    typeof request.workspaceRoot !== "string" ||
    lightWorkspaceExecutionTarget(request) !== "managed-runtime"
  ) {
    throw new Error("Invalid managed semantic workspace request");
  }
  return runtimeAgentClient().lightWorkspace(request, signal);
}

async function agentGit(input: unknown) {
  const request = recordInput(input);
  const cwd = request.cwd;
  const args = request.args;
  if (typeof cwd !== "string" || !stringArray(args)) {
    throw new Error("Invalid agent Git request");
  }
  if (runtimeManagedPath(cwd)) return runtimeManagedGit(cwd, args);
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: withoutTelemetryEnvironment(process.env),
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function runtimeManagedGit(cwd: string, args: string[]) {
  await ensureRuntimeGitUserIdentity();
  const { name, email } = getRuntimeGitIdentity();
  const { stdout } = await runRuntime("git", args, {
    cwd,
    env: runtimeGitEnvironment(name, email),
  });
  return stdout;
}

function runtimeGitEnvironment(name?: string, email?: string) {
  return {
    ...withoutTelemetryEnvironment(process.env),
    ...gitIdentityEnvironment(name, email),
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: gitSshCommand(),
  };
}

function gitIdentityEnvironment(name?: string, email?: string) {
  return {
    ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}),
    ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}),
  };
}

function gitSshCommand() {
  return process.platform === "win32"
    ? "ssh.exe -o BatchMode=yes -o StrictHostKeyChecking=no"
    : "ssh -o BatchMode=yes -o StrictHostKeyChecking=no";
}

function openAgentExternalUrl(input: unknown) {
  const value = recordInput(input).url;
  if (typeof value !== "string") throw new Error("Invalid external URL");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Invalid external URL");
  }
  void shell.openExternal(url.toString());
  return true;
}

function recordInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  return input as Record<string, unknown>;
}

async function advancedDiagnostics(projectId: unknown) {
  const { previewDevtoolsSettings } =
    await import("./ipc/preview-devtools-settings-ipc.ts");
  return previewDevtoolsSettings()
    .advancedDiagnostics(optionalText(projectId))
    .catch(() => false);
}

function optionalText(value: unknown) {
  return typeof value === "string" && value && value.length <= 512
    ? value
    : undefined;
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
