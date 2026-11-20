import type { LightWorkspaceExecutionRequest } from "@blame/agent-runtime";
import { shell } from "electron";
import type { AgentHostMethod } from "./agent-runtime-process-protocol.ts";
import { reloadPreviewBrowserForScope } from "./preview-browser-ipc.ts";
import { PreviewHarnessService } from "./preview-runtime/preview-harness-service.ts";
import type { PreviewService } from "./preview-runtime/preview-service.ts";
import { runtimeAgentClient, runtimeAgentSupported } from "./runtime-agent.ts";
import { lightWorkspaceExecutionTarget } from "./light-workspace-routing.ts";
import { agentHeavyChecks } from "./agent-heavy-checks.ts";
import { sessionCommandCredentials, withSessionCommandCredentials } from "./github-access/agent-github-access.ts";
import {
  engineDesktopServices,
  type EngineDesktopHandlers,
} from "./engine/engine-desktop-services.ts";

export function createAgentHostRequestHandler(previews: PreviewService) {
  const harness = new PreviewHarnessService(previews);
  const desktop = engineDesktopServices(previews, harness);
  return (method: AgentHostMethod, input: unknown, signal: AbortSignal) =>
    handleAgentHostRequest(method, input, signal, harness, desktop, previews);
}

async function handleAgentHostRequest(
  method: AgentHostMethod,
  input: unknown,
  signal: AbortSignal,
  harness: PreviewHarnessService,
  desktop: EngineDesktopHandlers,
  previews: PreviewService,
) {
  // The services the engine's tools use too (engine-desktop-services.ts).
  if (method in desktop)
    return desktop[method as keyof EngineDesktopHandlers](input as never, signal);
  if (method === "openExternalUrl") return openAgentExternalUrl(input);
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
  if (method === "commandCredentials")
    return sessionCommandCredentials(recordInput(input).sessionId);
  throw new Error(`Unsupported agent host method: ${method}`);
}

// The agent process removes a temporary copy itself once its scan is done.
async function agentProjectScanRoot(input: unknown) {
  const workspace = String(recordInput(input).workspace ?? "");
  const { projectScanRoot } = await import("./runtime-workspace-mirror.ts");
  const { root, temporary } = await projectScanRoot(workspace);
  return { root, temporary };
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
  return agentHeavyChecks.run(request, signal, () =>
    runtimeAgentClient().lightWorkspace(
      withSessionCommandCredentials(request),
      signal,
    ),
  );
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
