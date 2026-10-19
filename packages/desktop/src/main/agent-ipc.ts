import type {
  AgentEvent,
  NewProjectGenerationResult,
  StartNewProjectGenerationInput,
} from "@blame/agent-runtime";
import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import log from "electron-log";
import { optimizeDevelopmentAttachments } from "./attachment-ai-context";
import {
  refreshRuntimeBackendConnection,
  resolveAgentWorkspaceInput,
  retryableHubTransportError,
} from "./cline-backend-resolver";
import { AgentEventStream } from "./agent-event-stream";
import { AgentRuntimePool } from "./agent-runtime-pool";
import {
  AgentRuntimeProcessClient,
  type AgentRuntimeProcessCallbacks,
} from "./agent-runtime-process-client";
import { createAgentHostRequestHandler } from "./agent-runtime-main-host";
import { getRuntimeStatus } from "./runtime-manager";
import { runtimeAgentClient } from "./runtime-agent";
import { registerSecurityAuditIpcHandlers } from "./security-audit-ipc";
import { WorkspaceWriterRegistry } from "./workspaces/workspace-writer-registry";
import type { PreviewService } from "./preview-runtime/preview-service";

type AgentRuntimeRegistration = {
  modulePath: string;
  packaged: boolean;
  serviceVersion: string;
  previewService: PreviewService;
  beforeDelivery?(worktree: string): Promise<void>;
  beforeWorkspaceWrite?(worktree: string): Promise<void>;
};

let runtime: AgentRuntimePool | undefined;
let runtimePrewarmPromise: Promise<boolean> | undefined;
const runtimePrewarmWorkspace =
  "/home/blame/.local/share/blame/runtime/worktrees/.prewarm";
const agentWorkspaceWriters = new WorkspaceWriterRegistry();

export function registerAgentIpcHandlers(input: AgentRuntimeRegistration) {
  runtime ??= createAgentRuntimePool(input);
  registerProviderIpcHandlers();
  registerSessionStartIpcHandlers(input.beforeWorkspaceWrite);
  registerSessionControlIpcHandlers(input.beforeWorkspaceWrite);
  registerSessionDataIpcHandlers(input.beforeWorkspaceWrite);
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

export function prewarmAgentRuntime(runtimeAlreadyReady = false) {
  if (process.platform !== "darwin") return Promise.resolve(false);
  if (runtimePrewarmPromise) return runtimePrewarmPromise;
  const startedAt = Date.now();
  const prewarm = prewarmMacosAgentRuntime(runtimeAlreadyReady)
    .then((ready) => {
      if (ready) {
        log.info(
          `Agent runtime prewarm completed in ${Date.now() - startedAt}ms`,
        );
      }
      return ready;
    })
    .catch((error) => {
      log.warn("Agent runtime prewarm failed", error);
      return false;
    });
  runtimePrewarmPromise = prewarm;
  void prewarm.then((ready) => {
    if (!ready && runtimePrewarmPromise === prewarm) {
      runtimePrewarmPromise = undefined;
    }
  });
  return prewarm;
}

async function prewarmMacosAgentRuntime(runtimeAlreadyReady: boolean) {
  const report = runtimeAlreadyReady ? undefined : await getRuntimeStatus();
  if (report && report.status !== "ready") return false;
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
    {
      agentClient: client,
      ensureReady: async () =>
        report ?? {
          issues: [],
          platform: "darwin",
          runtime: "BlameRuntime",
          status: "ready",
          updateRequired: false,
        },
      platform: "darwin",
    },
  );
  await agentRuntime().run("runtime.prewarm", workspace);
  return true;
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
}

function registerSessionStartIpcHandlers(
  beforeWorkspaceWrite?: (worktree: string) => Promise<void>,
) {
  ipcMain.handle("agent:sessions:start", async (_event, input) => {
    const prepared = await agentWorkspaceInput(input);
    const workspace = agentWorkspacePath(prepared);
    if (workspace && beforeWorkspaceWrite)
      await beforeWorkspaceWrite(workspace);
    return startWorkspaceSession("sessions.start", prepared, workspace);
  });
  ipcMain.handle("agent:sessions:start-development", async (_event, input) => {
    const prepared = await optimizeDevelopmentAttachments(
      await agentWorkspaceInput({
        ...input,
        sessionId:
          typeof input.sessionId === "string" && input.sessionId.trim()
            ? input.sessionId
            : `${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 5)}`,
      }),
    );
    const workspace = agentWorkspacePath(prepared);
    if (workspace && beforeWorkspaceWrite)
      await beforeWorkspaceWrite(workspace);
    let session;
    const pendingSessionId = workspace ? `pending:${randomUUID()}` : undefined;
    if (workspace && pendingSessionId)
      agentWorkspaceWriters.begin(pendingSessionId, workspace);
    const sessionInput = eventStream.prepareSession(prepared);
    try {
      session = await agentRuntime().startSession(
        "sessions.startDevelopment",
        sessionInput,
      );
    } catch (error) {
      if (!retryableHubTransportError(error)) throw error;
      log.warn(
        "Cline hub connection closed during session start; refreshing the runtime backend and retrying once",
      );
      session = await agentRuntime().startSession(
        "sessions.startDevelopment",
        refreshRuntimeBackendConnection(
          await agentWorkspaceInput(sessionInput),
        ),
      );
    } finally {
      if (pendingSessionId && !session)
        agentWorkspaceWriters.forget(pendingSessionId);
    }
    if (pendingSessionId)
      agentWorkspaceWriters.rebind(pendingSessionId, session.sessionId);
    return session;
  });
}

function registerSessionControlIpcHandlers(
  beforeWorkspaceWrite?: (worktree: string) => Promise<void>,
) {
  ipcMain.handle("agent:sessions:send", async (_event, input) => {
    await beforeAgentSessionWrite(input.sessionId, beforeWorkspaceWrite);
    return runWorkspaceSession("sessions.send", input.sessionId, input);
  });
  ipcMain.handle("agent:sessions:send-development", async (_event, input) => {
    await beforeAgentSessionWrite(input.sessionId, beforeWorkspaceWrite);
    return runWorkspaceSession(
      "sessions.sendDevelopment",
      input.sessionId,
      await optimizeDevelopmentAttachments(input),
    );
  });
  ipcMain.handle("agent:sessions:abort", async (_event, sessionId) => {
    try {
      return await agentRuntime().abortSession(sessionId);
    } finally {
      agentWorkspaceWriters.end(sessionId);
    }
  });
}

function registerSessionDataIpcHandlers(
  beforeWorkspaceWrite?: (worktree: string) => Promise<void>,
) {
  ipcMain.handle("agent:sessions:compare-checkpoint", (_event, input) =>
    agentRuntime().runSession(
      "sessions.compareCheckpoint",
      input.sessionId,
      input,
    ),
  );
  ipcMain.handle("agent:sessions:list", () => agentRuntime().listSessions());
  ipcMain.handle("agent:sessions:messages", (_event, sessionId) =>
    agentRuntime().runSession("sessions.messages", sessionId, sessionId),
  );
  ipcMain.handle("agent:sessions:restore-checkpoint", async (_event, input) => {
    await beforeAgentSessionWrite(input.sessionId, beforeWorkspaceWrite);
    return runWorkspaceSession(
      "sessions.restoreCheckpoint",
      input.sessionId,
      input,
    );
  });
  ipcMain.handle("agent:sessions:usage", (_event, sessionId) =>
    agentRuntime().runSession("sessions.usage", sessionId, sessionId),
  );
  ipcMain.handle("agent:sessions:event-stream-url", (_event, sessionId) =>
    agentEventStreamUrl(sessionId),
  );
}

function registerSessionEventIpcHandlers() {
  ipcMain.on("agent:sessions:listen", (event, sessionId: string) => {
    registerRendererAgentEventCleanup(event.sender);
    setRendererAgentEventSubscription(event.sender.id, sessionId, true);
  });
  ipcMain.on("agent:sessions:unlisten", (event, sessionId: string) =>
    setRendererAgentEventSubscription(event.sender.id, sessionId, false),
  );
  ipcMain.handle("agent:approvals:resolve", (_event, input) =>
    agentRuntime().resolveApproval(input),
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
    const resolved = await agentWorkspaceInput(input);
    if (typeof resolved.worktree !== "string" || !resolved.worktree) {
      throw new Error("Agent delivery worktree is invalid");
    }
    if (beforeDelivery) await beforeDelivery(resolved.worktree);
    return runWorkspaceTask(resolved.worktree, () =>
      agentRuntime().run("approveAndMerge", resolved),
    );
  });
  ipcMain.handle("agent:generate-commit-message", (_event, input) =>
    agentWorkspaceInput(input).then((resolved) =>
      agentRuntime().run("generateCommitMessage", resolved),
    ),
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

async function beforeAgentSessionWrite(
  sessionId: string,
  callback?: (worktree: string) => Promise<void>,
) {
  const workspace = agentWorkspaceWriters.workspaceForSession(sessionId);
  if (workspace && callback) await callback(workspace);
}

async function startWorkspaceSession(
  method: "sessions.start",
  input: Record<string, unknown>,
  workspace: string | undefined,
) {
  const pendingSessionId = workspace ? `pending:${randomUUID()}` : undefined;
  if (workspace && pendingSessionId)
    agentWorkspaceWriters.begin(pendingSessionId, workspace);
  try {
    const session = await agentRuntime().startSession(
      method,
      eventStream.prepareSession(input),
    );
    if (pendingSessionId)
      agentWorkspaceWriters.rebind(pendingSessionId, session.sessionId);
    return session;
  } catch (error) {
    if (pendingSessionId) agentWorkspaceWriters.forget(pendingSessionId);
    throw error;
  }
}

async function runWorkspaceSession(
  method:
    | "sessions.send"
    | "sessions.sendDevelopment"
    | "sessions.restoreCheckpoint",
  sessionId: string,
  input: unknown,
) {
  const workspace = agentWorkspaceWriters.workspaceForSession(sessionId);
  if (workspace) agentWorkspaceWriters.begin(sessionId, workspace);
  try {
    return await agentRuntime().runSession(method, sessionId, input);
  } catch (error) {
    agentWorkspaceWriters.end(sessionId);
    throw error;
  }
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
  agentWorkspaceWriters.releaseWorkspace(worktree);
  return agentRuntime().releaseWorkspace(worktree);
}

export function localAgentOwnsWorkspace(worktree: string) {
  return agentWorkspaceWriters.hasActiveWriter(worktree);
}

export async function shutdownAgentRuntime() {
  shutdownAgentEventServer();
  agentWorkspaceWriters.clear();
  const currentRuntime = runtime;
  runtime = undefined;
  await currentRuntime?.shutdown();
}

export function configureAgentRuntimeTelemetry(session: unknown) {
  return runtime?.configureTelemetry(session);
}

export function disableAgentRuntimeTelemetry() {
  return runtime?.disableTelemetry();
}

function createAgentRuntimePool(input: AgentRuntimeRegistration) {
  const environment = {
    ...process.env,
    BLAME_AGENT_PACKAGED: String(input.packaged),
    BLAME_AGENT_SERVICE_VERSION: input.serviceVersion,
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

function emitAgentEvent(event: AgentEvent) {
  if (event.sessionId && (event.type === "done" || event.type === "error")) {
    agentWorkspaceWriters.end(event.sessionId);
  }
  const rawTransportEvent = agentTransportEvent(event);
  const transportEvent =
    eventStream.publish(rawTransportEvent) ?? rawTransportEvent;
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
    if (transportEvent.type === "approval") {
      window.webContents.send("agent:approvals:event", transportEvent);
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

const eventStream = new AgentEventStream();
const rendererAgentEventSubscriptions = new Map<number, Map<string, number>>();
const rendererAgentEventCleanupRegistered = new Set<number>();
let streamServer: ReturnType<typeof createServer> | undefined;
let streamServerUrl: string | undefined;

async function agentEventStreamUrl(sessionId: string) {
  const url = await ensureAgentEventServer();
  return eventStream.url(sessionId, url);
}

function ensureAgentEventServer() {
  if (streamServerUrl) return Promise.resolve(streamServerUrl);
  if (streamServer) return waitForAgentEventServer();
  streamServer = createServer((request, response) => {
    if (!eventStream.handle(request, response)) notFound(response);
  });
  streamServer.listen(0, "127.0.0.1");
  return waitForAgentEventServer();
}

function waitForAgentEventServer() {
  return new Promise<string>((resolve, reject) => {
    if (!streamServer)
      return reject(new Error("Agent event stream is unavailable."));
    streamServer.once("error", reject);
    streamServer.once("listening", () => {
      const address = streamServer?.address() as AddressInfo | null;
      if (!address)
        return reject(new Error("Agent event stream is unavailable."));
      streamServerUrl = `http://127.0.0.1:${address.port}`;
      resolve(streamServerUrl);
    });
  });
}

function notFound(response: import("node:http").ServerResponse) {
  response.writeHead(404);
  response.end();
}

function shutdownAgentEventServer() {
  eventStream.close();
  rendererAgentEventSubscriptions.clear();
  rendererAgentEventCleanupRegistered.clear();
  streamServer?.close();
  streamServer = undefined;
  streamServerUrl = undefined;
}

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
