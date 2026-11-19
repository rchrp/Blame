import type { AgentToolContext } from "@cline/sdk";
import { createInitialTaskBriefing } from "./initial-task-briefing.js";
import type {
  LightCommandCredentials,
  LightEditCodeInput,
  LightReadCodeInput,
  LightRunTaskInput,
  LightSearchCodeInput,
  LightTaskContract,
  LightToolResult,
} from "./light-contracts.js";
import { executeLocalFinishTask } from "./light-finish-service.js";
import { LightWorkspace } from "./light-workspace.js";
import { contextGeneration } from "./light-read-results.js";
import { SessionJournal } from "./session-journal.js";
import { storeWorkspaceAttachment } from "../development-attachments.js";
import { readAttachment } from "../attachment-reader.js";

export const lightWorkspaceToolNames = [
  "search_code",
  "read_code",
  "edit_code",
  "run_task",
  "finish_task",
  "initial_task_briefing",
  "session_journal",
  "store_attachment",
  "read_attachment",
] as const;

export type LightWorkspaceToolName = (typeof lightWorkspaceToolNames)[number];

export type LightWorkspaceExecutionRequest = {
  /** Set by the desktop on managed runtime requests only, never by the agent. */
  commandCredentials?: LightCommandCredentials;
  execution?: {
    backendMode?: "auto" | "local" | "hub" | "remote";
    workspaceMode?: "local-container" | "cloud-mirror" | "direct";
  };
  input: unknown;
  taskContract?: LightTaskContract;
  tool: LightWorkspaceToolName;
  toolContext?: LightToolContext;
  workspaceRoot: string;
};

export type LightToolContext = {
  agentId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  snapshot?: unknown;
  toolCallId?: string;
};

export type LightWorkspaceExecutor = (
  request: LightWorkspaceExecutionRequest,
  signal?: AbortSignal,
) => Promise<LightToolResult<unknown>>;

export function lightToolContext(
  context: Partial<AgentToolContext> | undefined,
): LightToolContext {
  if (!context) return {};
  return {
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.conversationId
      ? { conversationId: context.conversationId }
      : {}),
    metadata: {
      ...context.metadata,
      contextGeneration: contextGeneration(context),
    },
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
  };
}

export function managedLightWorkspaceExecutor(
  executor: LightWorkspaceExecutor | undefined,
  execution: LightWorkspaceExecutionRequest["execution"],
) {
  if (
    !executor ||
    execution?.workspaceMode !== "local-container" ||
    execution.backendMode !== "remote"
  )
    return undefined;
  return (request: LightWorkspaceExecutionRequest, signal?: AbortSignal) =>
    executor({ ...request, execution }, signal);
}

export function localLightWorkspaceExecutor(
  workspaceRoot: string,
  taskContract?: LightTaskContract,
): LightWorkspaceExecutor {
  const workspace = new LightWorkspace(workspaceRoot, {
    sessionId: taskContract?.session_id ?? "unscoped-session",
    taskContract,
  });
  return (request, signal) => executeWithWorkspace(workspace, request, signal);
}

type CachedWorkspace = {
  inFlight: number;
  lastUsedAt: number;
  workspace: LightWorkspace;
};

/**
 * One workspace per root and task contract, kept between requests: a
 * long-lived harness keeps a session's managed runs, its command queue and
 * its warm caches, where a process per request lost them after each call.
 * Each holds its indexes (measured 2026-11-19: ~7 MB of heap for a 765-file
 * project, ~30 MB for 3,700 files), so one that served nothing for an hour,
 * like the Claude Code process of its session, is dropped, and at most
 * `limit` stay; one running a command always stays.
 */
export function cachedLightWorkspaceExecutor(
  options: { idleMs?: number; limit?: number } = {},
): LightWorkspaceExecutor {
  const idleMs = options.idleMs ?? 60 * 60_000;
  const limit = options.limit ?? 8;
  const workspaces = new Map<string, CachedWorkspace>();
  const busy = (entry: CachedWorkspace) => entry.inFlight > 0 || entry.workspace.tasks.running;
  const sweep = () => {
    const now = Date.now();
    for (const [key, entry] of workspaces)
      if (!busy(entry) && now - entry.lastUsedAt >= idleMs) workspaces.delete(key);
    // Least recently used first.
    for (const [key, entry] of workspaces) {
      if (workspaces.size <= limit) break;
      if (!busy(entry)) workspaces.delete(key);
    }
  };
  setInterval(sweep, Math.min(idleMs, 5 * 60_000)).unref();
  return async (request, signal) => {
    sweep();
    const key = JSON.stringify([request.workspaceRoot, request.taskContract ?? null]);
    const entry = workspaces.get(key) ?? {
      inFlight: 0,
      lastUsedAt: 0,
      workspace: new LightWorkspace(request.workspaceRoot, {
        sessionId: request.taskContract?.session_id ?? "unscoped-session",
        taskContract: request.taskContract,
      }),
    };
    workspaces.delete(key);
    workspaces.set(key, entry);
    entry.inFlight += 1;
    entry.lastUsedAt = Date.now();
    // A new workspace may take the place of the least recently used.
    sweep();
    try {
      return await executeWithWorkspace(entry.workspace, request, signal);
    } finally {
      entry.inFlight -= 1;
      entry.lastUsedAt = Date.now();
    }
  };
}

export function executeLightWorkspaceRequest(
  request: LightWorkspaceExecutionRequest,
  signal?: AbortSignal,
) {
  return localLightWorkspaceExecutor(
    request.workspaceRoot,
    request.taskContract,
  )(request, signal);
}

async function executeWithWorkspace(
  workspace: LightWorkspace,
  request: LightWorkspaceExecutionRequest,
  signal?: AbortSignal,
): Promise<LightToolResult<unknown>> {
  const context = agentContext(request.toolContext, signal);
  switch (request.tool) {
    case "read_attachment":
      return readAttachment(request.workspaceRoot, request.input, signal);
    case "search_code":
      return workspace.searchCode(
        request.input as LightSearchCodeInput,
        signal,
      );
    case "read_code":
      return workspace.readCode(request.input as LightReadCodeInput, context);
    case "edit_code":
      return workspace.editCode(request.input as LightEditCodeInput, context);
    case "run_task":
      return workspace.runTask(request.input as LightRunTaskInput, {
        ...context,
        commandCredentials: request.commandCredentials,
      });
    case "finish_task":
      return finishRequest(request, context);
    case "initial_task_briefing":
      return briefingRequest(request);
    case "store_attachment":
      return {
        status: "ok",
        data: {
          path: await storeWorkspaceAttachment(
            request.workspaceRoot,
            request.input,
          ),
        },
      };
    case "session_journal": {
      const sessionId = request.toolContext?.sessionId;
      if (!sessionId) throw new Error("Session journal requires a session ID");
      await writeSessionJournal({
        workspaceRoot: request.workspaceRoot,
        sessionId,
        input: request.input as SessionJournalInput,
      });
      return { status: "ok", data: {} };
    }
  }
}

export type SessionJournalInput =
  | { kind: "request"; id: string; text: string }
  | { kind: "terminal"; state: string };

export async function writeSessionJournal(options: {
  workspaceRoot: string;
  sessionId: string;
  input: SessionJournalInput;
  executor?: LightWorkspaceExecutor;
}) {
  if (options.executor) {
    const result = await options.executor({
      tool: "session_journal",
      workspaceRoot: options.workspaceRoot,
      toolContext: { sessionId: options.sessionId },
      input: options.input,
    });
    if (result?.status !== "ok")
      throw new Error("Unable to write the remote session journal");
    return;
  }
  const journal = new SessionJournal(options.workspaceRoot, options.sessionId);
  await journal.hydrate();
  if (options.input.kind === "request")
    await journal.ingestUserRequest(options.input.id, options.input.text);
  else if (options.input.kind === "terminal")
    await journal.recordTerminal(options.input.state);
  else throw new Error("Unsupported session journal operation");
}

function finishRequest(
  request: LightWorkspaceExecutionRequest,
  context: AgentToolContext,
) {
  return executeLocalFinishTask({
    context,
    input: request.input,
    taskContract: request.taskContract,
    workspaceRoot: request.workspaceRoot,
  });
}

async function briefingRequest(request: LightWorkspaceExecutionRequest) {
  const briefing = await createInitialTaskBriefing({
    taskContract: request.taskContract,
    workspaceRoot: request.workspaceRoot,
  });
  return { status: "ok" as const, data: { briefing } };
}

function agentContext(
  context: LightToolContext | undefined,
  signal?: AbortSignal,
) {
  return { ...context, signal } as AgentToolContext;
}
