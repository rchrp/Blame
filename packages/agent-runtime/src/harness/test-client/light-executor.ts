import type { LightTaskContract, LightToolResult } from "../light-contracts.js";
import { HarnessProcess, unit } from "./harness.js";

// The executor interface the behavioural tests drive (a workspace request:
// `{ tool, workspaceRoot, input, taskContract?, toolContext?,
// commandCredentials? }`), served by blame-harness's `request`.

export type LightWorkspaceExecutionRequest = {
  commandCredentials?: unknown;
  input: unknown;
  taskContract?: LightTaskContract;
  tool: string;
  toolContext?: Record<string, unknown>;
  workspaceRoot: string;
};

export type LightWorkspaceExecutor = (request: LightWorkspaceExecutionRequest, signal?: AbortSignal) => Promise<LightToolResult<unknown>>;

/** `lightToolContext`: the identities and metadata a workspace call keeps. */
export const lightToolContext = (context: unknown) => unit("lightToolContext", context ?? {}) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One harness for many requests, as the engine keeps one. */
export function cachedLightWorkspaceExecutor(_options: { idleMs?: number; limit?: number } = {}): LightWorkspaceExecutor {
  const harness = new HarnessProcess();
  return (request, signal) => harness.send("request", request, signal) as Promise<LightToolResult<unknown>>;
}

export function localLightWorkspaceExecutor(workspaceRoot: string, taskContract?: LightTaskContract): LightWorkspaceExecutor {
  const harness = new HarnessProcess();
  const contract = { ...taskContract, session_id: taskContract?.session_id ?? "unscoped-session" };
  return (request, signal) =>
    harness.send("request", { ...request, workspaceRoot, taskContract: contract }, signal) as Promise<LightToolResult<unknown>>;
}

const shared = new HarnessProcess();

export function executeLightWorkspaceRequest(request: LightWorkspaceExecutionRequest, signal?: AbortSignal) {
  return shared.send("request", request, signal) as Promise<LightToolResult<unknown>>;
}
