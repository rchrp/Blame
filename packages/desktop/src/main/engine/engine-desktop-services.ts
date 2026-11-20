// The desktop services the agents' tools use (`DesktopServices` in
// @blame/agent-runtime/engine-protocol): the preview's browser, containers,
// variables and screen, the screenshot store, the component preview server,
// the session's GitHub MCP connection, the project runner and Git. The engine
// host asks for them with `desktop-request` messages (engine-host-ipc.ts);
// each answer is plain JSON.

import type {
  EngineDesktopMethod,
  EngineDesktopMethods,
} from "@blame/agent-runtime/engine-protocol";
import { vmEngineBinaries } from "./engine-binary.ts";
import { prepareVmEngine, vmEngineTarget } from "./vm-engine.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  agentScreenshotStore,
  storePreviewDevtoolsScreenshots,
} from "../agent-screenshots/agent-screenshots-service.ts";
import { githubMcpService } from "../github-access/github-mcp-service.ts";
import { hostGitCommand } from "../host-git.ts";
import {
  agentPreviewPageState,
  holdAgentPreviewBrowser,
  openPreviewDevtoolsEndpoint,
} from "../preview-browser-ipc.ts";
import {
  previewDevtoolsService,
  type PreviewDevtoolsService,
} from "../preview-runtime/preview-devtools-service.ts";
import { PreviewHarnessService } from "../preview-runtime/preview-harness-service.ts";
import { previewLogService } from "../preview-runtime/preview-log-service.ts";
import { ensureLocalPreviewAwake } from "../preview-runtime/local/local-preview-hibernation.ts";
import type { PreviewService } from "../preview-runtime/preview-service.ts";
import {
  agentSurfaceCall,
  agentSurfaceInfo,
} from "../preview-surfaces/surface-agent.ts";
import {
  ensureRuntimeGitUserIdentity,
  getRuntimeGitIdentity,
  run as runRuntime,
  runtimeManagedPath,
} from "../workspace-runtime.ts";

const execFileAsync = promisify(execFile);

/** One service: its JSON input and the request's signal. */
export type EngineDesktopHandlers = {
  [M in EngineDesktopMethod]: (
    input: EngineDesktopMethods[M]["input"],
    signal: AbortSignal,
  ) => Promise<EngineDesktopMethods[M]["result"]>;
};

export function engineDesktopServices(
  previews: PreviewService,
  harness = new PreviewHarnessService(previews),
  devtools: PreviewDevtoolsService = previewDevtoolsService,
): EngineDesktopHandlers {
  return {
    renderWebPage: async (input, signal) => {
      const { renderResearchPage } = await import("../web-research-browser.ts");
      return renderResearchPage(String(record(input).url ?? ""), signal);
    },
    // The ChatGPT sign-in page, or an MCP server's; nothing else asks.
    openExternal: async (input) => {
      const request = record(input);
      const url = String(request.url ?? "");
      if (
        request.mcpAuthorization === true
          ? !mcpAuthorizationUrl(url)
          : !/^https:\/\/auth\.openai\.com\//.test(url)
      )
        throw new Error("Only a sign-in page opens from the engine host.");
      const { shell } = await import("electron");
      await shell.openExternal(url);
      return null;
    },
    previewDevtools: (input, signal) =>
      previewDevtoolsTarget(input, signal, harness, devtools) as never,
    previewDevtoolsTools: async () => devtools.listTools() as never,
    previewDevtoolsCall: (input, signal) =>
      previewDevtoolsCall(input, signal, harness, devtools),
    previewContainerLogs: (input, signal) =>
      previewContainerLogs(input, signal, harness),
    previewEnvironment: async (input) => {
      const { agentPreviewEnvironment } =
        await import("../preview-environment/agent-environment.ts");
      return agentPreviewEnvironment(input) as never;
    },
    previewSurfaceInfo: async (input) =>
      agentSurfaceInfo(input as never, previews) as never,
    previewSurfaceCall: async (input, signal) => {
      await wakeAgentPreview(input);
      return agentSurfaceCall(input as never, previews, signal);
    },
    previewScreenshotKnown: (input) => previewScreenshotKnown(input),
    projectApp: (input, signal) => agentProjectApp(input, signal),
    componentPreview: async (input, signal) => {
      await wakeAgentPreview(input);
      const { componentPreviewHostRequest } =
        await import("../component-preview/component-preview-agent.ts");
      return componentPreviewHostRequest(input, signal, previews);
    },
    githubMcpTools: async (input) =>
      githubMcpService.listTools(optionalText(record(input).sessionId)),
    githubMcpCall: (input, signal) => githubMcpCall(input, signal),
    git: (input) => agentGit(input),
    applyPreviewInitialization: (input) => applyPreviewInitialization(input),
    prepareVmEngine: () => prepareThisVmEngine(),
    commandCredentials: async (input) => {
      const { harnessCommandCredentials } =
        await import("../github-access/agent-github-access.ts");
      const request = record(input);
      return harnessCommandCredentials(
        String(request.sessionId ?? ""),
        request.location === "vm" ? "vm" : "host",
      );
    },
    refreshPreviewDependencies: (input, signal) =>
      refreshPreviewDependencies(input, signal, harness, previews),
  };
}

// A dependency the harness added or removed reaches the story's preview:
// the local preview runtime installs it (a cloud preview syncs first), the
// preview's browser reloads, and the state once it is ready is the result.
async function refreshPreviewDependencies(
  input: unknown,
  signal: AbortSignal,
  harness: PreviewHarnessService,
  previews: PreviewService,
) {
  const request = record(input);
  const worktree = String(request.worktree ?? "");
  try {
    if (request.workspaceMode === "cloud-mirror") {
      await previews.syncBarrier(worktree);
    } else {
      const { refreshProjectPreviewDependencies } =
        await import("../workspace-ipc.ts");
      const local = await refreshProjectPreviewDependencies(worktree);
      if (local.status === "not_running") return local;
    }
    const { reloadPreviewBrowserForScope } =
      await import("../preview-browser-ipc.ts");
    reloadPreviewBrowserForScope({ scope: String(request.scope ?? "") });
    const state = await harness.target({
      ...request,
      signal,
      waitFor: "ready",
    } as never);
    if (state.status === "failed")
      return { diagnostic: state.message, status: "failed" as const };
    if (state.status === "stopped") return { status: "not_running" as const };
    const ready =
      state.status === "ready" ||
      (state.status === "unavailable" &&
        state.readiness.container_ready &&
        state.revisions?.dependencies_ready === true);
    if (!ready) return { diagnostic: state.message, status: "failed" as const };
    return {
      readiness: state.readiness,
      revisions: state.revisions,
      status: "ready" as const,
    };
  } catch (error) {
    return {
      diagnostic: error instanceof Error ? error.message : String(error),
      status: "failed" as const,
    };
  }
}

// The engine in this computer's runtime VM, for the engine host.
async function prepareThisVmEngine() {
  const target = vmEngineTarget();
  if ("missing" in target) throw new Error(target.missing);
  const { app } = await import("electron");
  const binaries = vmEngineBinaries({
    applicationPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
    // The VM has this computer's architecture (Lima vz, WSL).
    arch: process.arch === "arm64" ? "arm64" : "x64",
  });
  if ("missing" in binaries) throw new Error(binaries.missing);
  return prepareVmEngine({ engine: binaries.engine, target });
}

// An MCP server's sign-in: https, or http on this computer, with no
// credentials in it.
function mcpAuthorizationUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  return (
    !url.username &&
    !url.password &&
    (url.protocol === "https:" || (url.protocol === "http:" && loopback))
  );
}

// A story's repaired preview setup, applied to its managed preview (a
// cloud preview's is the cloud's to apply).
async function applyPreviewInitialization(input: unknown) {
  const request = record(input);
  if (request.workspaceMode === "cloud-mirror")
    return { status: "unavailable" as const };
  const { applyProjectPreviewInitialization } =
    await import("../workspace-ipc.ts");
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

// A surface or component preview of a hibernated local preview wakes it and
// waits until it answers; the devtools and log tools wake it through the
// harness.
async function wakeAgentPreview(input: unknown) {
  const request = record(input);
  const worktree = optionalText(request.worktree);
  if (!worktree || request.action === "stop") return;
  if (
    request.workspaceMode === "cloud-mirror" ||
    request.workspaceMode === "direct"
  )
    return;
  await ensureLocalPreviewAwake(worktree, "the agent's preview tool");
}

// A story working in the project folder checks or starts the project's
// app through the same runner as the user's header controls.
async function agentProjectApp(input: unknown, signal: AbortSignal) {
  const request = record(input);
  const { projectAppForAgent } = await import("../ipc/project-app-ipc.ts");
  return projectAppForAgent(
    {
      action: request.action === "start" ? "start" : "status",
      projectPath: String(request.worktree ?? ""),
    },
    signal,
  );
}

// The agent's browser and its DevTools connection open on the first
// preview_devtools__* call, not when readiness is inspected.
async function previewDevtoolsTarget(
  input: unknown,
  signal: AbortSignal,
  harness: PreviewHarnessService,
  devtools: PreviewDevtoolsService,
) {
  const request = record(input);
  const target = await harness.target({ ...request, signal } as never);
  if (!target.available) devtools.disposeScope(String(request.scope ?? ""));
  return target;
}

async function previewContainerLogs(
  input: unknown,
  signal: AbortSignal,
  harness: PreviewHarnessService,
) {
  const request = { ...record(input), signal } as never;
  const preview = await harness.inspect(request);
  const logs = await previewLogService.read(request, preview);
  // The agent reads the logs: the preview's secret values stay out.
  const { redactForWorktree } =
    await import("../preview-environment/secret-redaction.ts");
  const worktree = String(record(input).worktree ?? "");
  return worktree ? redactForWorktree(worktree, logs) : logs;
}

async function previewDevtoolsCall(
  input: unknown,
  signal: AbortSignal,
  harness: PreviewHarnessService,
  devtools: PreviewDevtoolsService,
) {
  const request = record(input);
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
    arguments: record(request.arguments),
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
  const request = record(input);
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

// The agent names the session; the desktop holds its token.
function githubMcpCall(input: unknown, signal: AbortSignal) {
  const request = record(input);
  const toolName = optionalText(request.toolName);
  if (!toolName) throw new Error("Invalid GitHub MCP request");
  const argumentsValue = request.arguments;
  return githubMcpService.call({
    arguments:
      argumentsValue &&
      typeof argumentsValue === "object" &&
      !Array.isArray(argumentsValue)
        ? (argumentsValue as Record<string, unknown>)
        : undefined,
    sessionId: optionalText(request.sessionId),
    signal,
    toolName,
  });
}

async function agentGit(input: unknown) {
  const request = record(input);
  const cwd = request.cwd;
  const args = request.args;
  if (typeof cwd !== "string" || !stringArray(args))
    throw new Error("Invalid agent Git request");
  if (runtimeManagedPath(cwd)) return runtimeManagedGit(cwd, args);
  const { stdout } = await execFileAsync(hostGitCommand(), args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function runtimeManagedGit(cwd: string, args: string[]) {
  await ensureRuntimeGitUserIdentity();
  const { name, email } = getRuntimeGitIdentity();
  const { stdout } = await runRuntime("git", args, {
    cwd,
    env: {
      ...process.env,
      ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}),
      ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}),
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND:
        process.platform === "win32"
          ? "ssh.exe -o BatchMode=yes -o StrictHostKeyChecking=no"
          : "ssh -o BatchMode=yes -o StrictHostKeyChecking=no",
    },
  });
  return stdout;
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  return input as Record<string, unknown>;
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
