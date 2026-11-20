import type { AgentEvent } from "@blame/agent-runtime";
import { app, BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import log from "electron-log";
import {
  clineAgentEnvironment,
  writeClineTelemetryOptOut,
} from "@blame/agent-runtime/cline-sdk-opt-out";
import { releaseAgentPreviewSession } from "./preview-browser-ipc";
import { resolveAgentWorkspaceInput } from "./cline-backend-resolver";
import { engineActiveWorkspaces } from "./engine/engine-host-ipc";
import { AgentRuntimePool } from "./agent-runtime-pool";
import { agentHeavyChecks } from "./agent-heavy-checks";
import {
  AgentRuntimeProcessClient,
  type AgentRuntimeProcessCallbacks,
} from "./agent-runtime-process-client";
import { createAgentHostRequestHandler } from "./agent-runtime-main-host";
import type { AgentRuntimeMethod } from "./agent-runtime-process-protocol";
import { setupPath } from "./host-tool-path";
import { keepRuntimeRunningWhile, onRuntimeRunning } from "./runtime-power";
import { runtimeAgentClient } from "./runtime-agent";
import { registerSecurityAuditIpcHandlers } from "./security-audit-ipc";
import { WorkspaceWriterRegistry } from "./workspaces/workspace-writer-registry";
import { runtimeManagedPath } from "./workspace-runtime";
import type { PreviewService } from "./preview-runtime/preview-service";
import { useAgentWorkspaceCheck } from "./preview-runtime/local/local-preview-idle.ts";

type AgentRuntimeRegistration = {
  modulePath: string;
  packaged: boolean;
  previewService: PreviewService;
  beforeWorkspaceWrite?(worktree: string): Promise<void>;
};

let runtime: AgentRuntimePool | undefined;
let runtimePrewarmPromise: Promise<void> | undefined;
const runtimePrewarmWorkspace =
  "/home/blame/.local/share/blame/runtime/worktrees/.prewarm";
const agentWorkspaceWriters = new WorkspaceWriterRegistry();

export function registerAgentIpcHandlers(input: AgentRuntimeRegistration) {
  runtime ??= createAgentRuntimePool(input);
  // A preview stays up while an agent works in its worktree.
  useAgentWorkspaceCheck(localAgentOwnsWorkspace);
  // The Blame Runtime starts when a story, preview or terminal needs it:
  // an agent is likely next. One at work there keeps it running.
  onRuntimeRunning(() => void prewarmAgentRuntime());
  keepRuntimeRunningWhile(() =>
    agentWorkspaceWriters
      .activeWorkspaces()
      .some((workspace) => runtimeManagedPath(workspace)),
  );
  registerSessionEventIpcHandlers();
  registerSecurityAuditIpcHandlers((securityInput) =>
    agentRuntime().run("securityAudits.map", securityInput),
  );
  registerDeliveryWorkflowIpcHandlers();
}

// Once per start of the runtime: a stop takes its Cline hub with it.
function prewarmAgentRuntime() {
  if (process.platform !== "darwin" || runtimePrewarmPromise) return;
  const startedAt = Date.now();
  runtimePrewarmPromise = prewarmMacosAgentRuntime()
    .then(() =>
      log.info(`Agent runtime prewarm completed in ${Date.now() - startedAt}ms`),
    )
    .catch((error) => log.warn("Agent runtime prewarm failed", error))
    .finally(() => {
      runtimePrewarmPromise = undefined;
    });
}

async function prewarmMacosAgentRuntime() {
  const client = runtimeAgentClient();
  await client.exec({
    args: ["-p", runtimePrewarmWorkspace],
    command: "mkdir",
    user: "blame",
  });
  const workspace = await resolveAgentWorkspaceInput(
    {
      cwd: runtimePrewarmWorkspace,
      workspaceRoot: runtimePrewarmWorkspace,
    },
    { agentClient: client, platform: "darwin" },
  );
  await agentRuntime().run("runtime.prewarm", workspace);
}

// Progress of the one-shot agents (project setup, new-project generation).
// Conversations run on the engine host (engine/engine-host-ipc.ts).
function registerSessionEventIpcHandlers() {
  ipcMain.on("agent:sessions:listen", (event, sessionId: string) => {
    registerRendererAgentEventCleanup(event.sender);
    setRendererAgentEventSubscription(event.sender.id, sessionId, true);
  });
  ipcMain.on("agent:sessions:unlisten", (event, sessionId: string) =>
    setRendererAgentEventSubscription(event.sender.id, sessionId, false),
  );
}

function registerDeliveryWorkflowIpcHandlers() {
  ipcMain.handle("agent:pull-request-availability", (_event, input) =>
    agentRuntime().run("pullRequestAvailability", input),
  );
  ipcMain.handle("agent:pull-request-state", (_event, input) =>
    agentRuntime().run("pullRequestState", input),
  );
  ipcMain.handle("agent:direct-story-files", (_event, input) =>
    agentRuntime().run("directStoryFiles", input),
  );
}

function agentWorkspacePath(input: unknown) {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  for (const key of ["workspaceRoot", "worktree", "cwd"]) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return undefined;
}

// The git flows run in the engine host; main adds what only it knows. The
// worktree's preview is synced first, the worktree counts as written while
// the flow runs, the target branch never moves under a running agent, and a
// worktree in the runtime VM is said to be one.
const engineGitFlows = new Set([
  "approveAndMerge",
  "openPullRequest",
  "generateCommitMessage",
  "resolveMergeConflicts",
]);
const engineDeliveries = new Set([
  "approveAndMerge",
  "openPullRequest",
  "resolveMergeConflicts",
]);

export async function engineGitFlowCall(
  method: string,
  input: unknown,
  call: (input: unknown) => Promise<unknown>,
  beforeDelivery?: (worktree: string) => Promise<void>,
) {
  if (!engineGitFlows.has(method)) return call(input);
  const flow = (input ?? {}) as Record<string, unknown>;
  const worktree = flow.worktree;
  if (typeof worktree !== "string" || !worktree)
    throw new Error("The git flow's worktree is invalid");
  const resolved = {
    ...flow,
    inVm: runtimeManagedPath(worktree),
    ...(method === "approveAndMerge"
      ? {
          activeWorktrees: [
            ...agentWorkspaceWriters.activeWorkspaces(),
            ...engineActiveWorkspaces(),
          ],
        }
      : {}),
  };
  if (!engineDeliveries.has(method)) return call(resolved);
  if (beforeDelivery) await beforeDelivery(worktree);
  return runWorkspaceTask(worktree, () => call(resolved));
}

async function runWorkspaceTask<T>(
  workspace: string | undefined,
  task: () => Promise<T>,
) {
  if (!workspace) return task();
  const operationId = `operation:${randomUUID()}`;
  agentWorkspaceWriters.begin(operationId, workspace);
  try {
    return await task();
  } finally {
    agentWorkspaceWriters.forget(operationId);
  }
}

export function releaseAgentWorkspaceSessions(worktree: string) {
  const sessionIds = agentWorkspaceWriters.releaseWorkspace(worktree);
  return agentRuntime().releaseWorkspace(worktree, sessionIds);
}

export function localAgentOwnsWorkspace(worktree: string) {
  return (
    agentWorkspaceWriters.hasActiveWriter(worktree) ||
    engineActiveWorkspaces().includes(worktree)
  );
}

export async function shutdownAgentRuntime() {
  rendererAgentEventSubscriptions.clear();
  rendererAgentEventCleanupRegistered.clear();
  agentWorkspaceWriters.clear();
  const currentRuntime = runtime;
  runtime = undefined;
  await currentRuntime?.shutdown();
}

function createAgentRuntimePool(input: AgentRuntimeRegistration) {
  const clineSettings = join(app.getPath("userData"), "cline", "settings.json");
  try {
    writeClineTelemetryOptOut(clineSettings);
  } catch (error) {
    log.warn("Could not write the agents' Cline settings", error);
  }
  const environment = {
    ...clineAgentEnvironment(process.env, clineSettings),
    // An app opened from the Finder inherits launchd's minimal PATH: agent
    // commands need the same Node, package manager and tool directories as
    // the other runtimes Blame starts.
    PATH: setupPath(),
    BLAME_AGENT_PACKAGED: String(input.packaged),
    BLAME_CLAUDE_CODE_STATE_DIR: join(app.getPath("userData"), "claude-code"),
    // Where cloud commands' gh is downloaded once (see github-cli.ts).
    BLAME_GITHUB_CLI_DIR: join(app.getPath("userData"), "github-cli"),
  };
  return new AgentRuntimePool({
    createProcess: (callbacks) =>
      createAgentRuntimeProcess(input.modulePath, environment, callbacks),
    handleHostRequest: createAgentHostRequestHandler(input.previewService),
    onEvent: emitAgentEvent,
  });
}

function createAgentRuntimeProcess(
  modulePath: string,
  environment: NodeJS.ProcessEnv,
  callbacks: AgentRuntimeProcessCallbacks,
) {
  return new AgentRuntimeProcessClient({
    ...callbacks,
    environment,
    modulePath,
  });
}

function agentRuntime() {
  if (!runtime) throw new Error("Agent runtime is not initialized");
  return runtime;
}

/** Work of the agent runtime for the rest of the main process, which never loads it. */
export function runOnAgentRuntime<Result>(
  method: AgentRuntimeMethod,
  input?: unknown,
) {
  return agentRuntime().run<Result>(method, input);
}

function emitAgentEvent(event: AgentEvent) {
  if (event.sessionId && (event.type === "done" || event.type === "error")) {
    agentWorkspaceWriters.end(event.sessionId);
    agentHeavyChecks.endSession(event.sessionId);
    releaseAgentPreviewSession(event.sessionId);
  }
  const transportEvent = agentTransportEvent(event);
  BrowserWindow.getAllWindows().forEach((window) => {
    if (
      transportEvent.sessionId &&
      rendererAgentEventSubscriptions
        .get(window.webContents.id)
        ?.has(transportEvent.sessionId)
    ) {
      window.webContents.send(
        `agent:sessions:event:${transportEvent.sessionId}`,
        transportEvent,
      );
    }
  });
}

function agentTransportEvent(event: AgentEvent): AgentEvent {
  return {
    ...event,
    payload: agentTransportPayload(event.payload),
  };
}

function agentTransportPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("raw" in payload)) {
    return payload;
  }
  const { raw, ...transportPayload } = payload as Record<string, unknown>;
  void raw;
  return transportPayload;
}

export function agentWorkspaceInput<T extends Record<string, unknown>>(
  input: T,
) {
  return resolveAgentWorkspaceInput(input);
}

const rendererAgentEventSubscriptions = new Map<number, Map<string, number>>();
const rendererAgentEventCleanupRegistered = new Set<number>();

function registerRendererAgentEventCleanup(
  renderer: import("electron").WebContents,
) {
  if (rendererAgentEventCleanupRegistered.has(renderer.id)) return;
  rendererAgentEventCleanupRegistered.add(renderer.id);
  renderer.once("destroyed", () => {
    rendererAgentEventSubscriptions.delete(renderer.id);
    rendererAgentEventCleanupRegistered.delete(renderer.id);
  });
}

function setRendererAgentEventSubscription(
  rendererId: number,
  sessionId: string,
  listening: boolean,
) {
  const sessions =
    rendererAgentEventSubscriptions.get(rendererId) ??
    new Map<string, number>();
  const count = sessions.get(sessionId) ?? 0;
  if (listening) sessions.set(sessionId, count + 1);
  else if (count > 1) sessions.set(sessionId, count - 1);
  else sessions.delete(sessionId);
  if (sessions.size) rendererAgentEventSubscriptions.set(rendererId, sessions);
  else rendererAgentEventSubscriptions.delete(rendererId);
}
