import type {
  AgentEvent,
  NewProjectGenerationResult,
  StartNewProjectGenerationInput,
} from "@blame/agent-runtime";
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
  beforeDelivery?(worktree: string): Promise<void>;
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
  registerProviderIpcHandlers();
  registerSessionEventIpcHandlers();
  registerAnalysisWorkflowIpcHandlers(input.beforeWorkspaceWrite);
  registerSecurityAuditIpcHandlers({
    resolveInput: (securityInput) => agentWorkspaceInput(securityInput),
    map: (securityInput) =>
      agentRuntime().run("securityAudits.map", securityInput),
    discover: (securityInput) =>
      agentRuntime().run("securityAudits.discover", securityInput),
    validate: (securityInput) =>
      agentRuntime().run("securityAudits.validate", securityInput),
    cancel: (auditId) => agentRuntime().cancelSecurityAudit(auditId),
    finish: (auditId) => agentRuntime().finishSecurityAudit(auditId),
  });
  registerDeliveryWorkflowIpcHandlers(input.beforeDelivery);
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

function registerProviderIpcHandlers() {
  ipcMain.handle("agent:providers:list", (_event, connection) =>
    agentRuntime().run("providers.list", connection),
  );
  ipcMain.handle(
    "agent:providers:save-credential",
    (_event, connection, input) =>
      agentRuntime().run("providers.saveCredential", [connection, input]),
  );
  ipcMain.handle(
    "agent:providers:delete-credential",
    (_event, connection, id) =>
      agentRuntime().run("providers.deleteCredential", [connection, id]),
  );
  ipcMain.handle("agent:providers:login-oauth", (_event, input) =>
    agentRuntime().run("providers.loginOAuth", input),
  );
  ipcMain.handle("agent:providers:claude-code-status", () =>
    agentRuntime().run("providers.claudeCodeStatus", undefined),
  );
  ipcMain.handle("agent:providers:connect-claude-code", (_event, input) =>
    agentRuntime().run("providers.connectClaudeCode", input),
  );
  ipcMain.handle("agent:providers:subscription-usage", (_event, input) =>
    agentRuntime().run("providers.subscriptionUsage", input),
  );
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

function registerAnalysisWorkflowIpcHandlers(
  beforeWorkspaceWrite?: (worktree: string) => Promise<void>,
) {
  ipcMain.handle("agent:initializations:run", async (_event, input) => {
    const resolved = await agentWorkspaceInput(input);
    const workspace = agentWorkspacePath(resolved);
    if (workspace && beforeWorkspaceWrite)
      await beforeWorkspaceWrite(workspace);
    return runWorkspaceTask(workspace, () =>
      agentRuntime().run("initializations.run", resolved),
    );
  });
  ipcMain.handle("agent:initializations:cancel", (_event, progressId) =>
    typeof progressId === "string" && runtime
      ? agentRuntime().cancelInitialization(progressId)
      : false,
  );
  ipcMain.handle("agent:initializations:repair", async (_event, input) => {
    const resolved = await agentWorkspaceInput(input);
    const workspace = agentWorkspacePath(resolved);
    if (workspace && beforeWorkspaceWrite)
      await beforeWorkspaceWrite(workspace);
    return runWorkspaceTask(workspace, () =>
      agentRuntime().run("initializations.repair", resolved),
    );
  });
  ipcMain.handle("agent:initializations:assess-impact", (_event, input) =>
    agentWorkspaceInput(input).then((resolved) =>
      agentRuntime().run("initializations.assessImpact", resolved),
    ),
  );
  ipcMain.handle("agent:code-practices:run", (_event, input) =>
    agentWorkspaceInput(input).then((resolved) =>
      agentRuntime().run("codePractices.run", resolved),
    ),
  );
}

function registerDeliveryWorkflowIpcHandlers(
  beforeDelivery?: (worktree: string) => Promise<void>,
) {
  ipcMain.handle("agent:new-projects:generate", (_event, input) =>
    agentRuntime().run("newProjects.generate", input),
  );
  ipcMain.handle(
    "agent:prompt-optimizer:optimize-user-story",
    (_event, input) =>
      agentWorkspaceInput(input).then((resolved) =>
        agentRuntime().run("promptOptimizer.optimizeUserStory", resolved),
      ),
  );
  ipcMain.handle("agent:prompt-optimizer:generate-title", (_event, input) =>
    agentWorkspaceInput(input).then((resolved) =>
      agentRuntime().run("promptOptimizer.generateTitle", resolved),
    ),
  );
  ipcMain.handle("agent:approve-and-merge", async (_event, input) => {
    const resolved = {
      ...(await agentWorkspaceInput(input)),
      // The target branch is never advanced under a running agent.
      activeWorktrees: [
        ...agentWorkspaceWriters.activeWorkspaces(),
        ...engineActiveWorkspaces(),
      ],
    };
    if (typeof resolved.worktree !== "string" || !resolved.worktree) {
      throw new Error("Agent delivery worktree is invalid");
    }
    if (beforeDelivery) await beforeDelivery(resolved.worktree);
    return runWorkspaceTask(resolved.worktree, () =>
      agentRuntime().run("approveAndMerge", resolved),
    );
  });
  // gh runs here, on the host, with the person's own sign-in.
  ipcMain.handle("agent:open-pull-request", async (_event, input) => {
    const resolved = await agentWorkspaceInput(input);
    if (typeof resolved.worktree !== "string" || !resolved.worktree) {
      throw new Error("Agent pull request worktree is invalid");
    }
    if (beforeDelivery) await beforeDelivery(resolved.worktree);
    return runWorkspaceTask(resolved.worktree, () =>
      agentRuntime().run("openPullRequest", resolved),
    );
  });
  ipcMain.handle("agent:pull-request-availability", (_event, input) =>
    agentRuntime().run("pullRequestAvailability", input),
  );
  ipcMain.handle("agent:pull-request-state", (_event, input) =>
    agentRuntime().run("pullRequestState", input),
  );
  ipcMain.handle("agent:generate-commit-message", (_event, input) =>
    agentWorkspaceInput(input).then((resolved) =>
      agentRuntime().run("generateCommitMessage", resolved),
    ),
  );
  ipcMain.handle("agent:direct-story-files", (_event, input) =>
    agentRuntime().run("directStoryFiles", input),
  );
  ipcMain.handle("agent:resolve-merge-conflicts", async (_event, input) => {
    const resolved = await agentWorkspaceInput(input);
    if (typeof resolved.worktree !== "string" || !resolved.worktree) {
      throw new Error("Agent merge-conflict worktree is invalid");
    }
    if (beforeDelivery) await beforeDelivery(resolved.worktree);
    return runWorkspaceTask(resolved.worktree, () =>
      agentRuntime().run("resolveMergeConflicts", resolved),
    );
  });
}

function agentWorkspacePath(input: unknown) {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  for (const key of ["workspaceRoot", "worktree", "cwd"]) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return undefined;
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

export function generateNewProjectWithAgent(
  input: StartNewProjectGenerationInput,
) {
  return agentWorkspaceInput(input).then((resolved) =>
    agentRuntime().run<NewProjectGenerationResult>(
      "newProjects.generate",
      resolved,
    ),
  );
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
