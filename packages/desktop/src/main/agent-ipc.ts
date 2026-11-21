// What the main process adds to the agents, which all run in the engine host
// (engine/engine-host-ipc.ts): the git flows' worktree and VM facts, which
// worktrees an agent is writing in (a preview stays up, the runtime keeps
// running), and the app's calls with no agent in them (Open PR's checks, a
// Direct story's files, a security audit's map).
import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { callEngineHost, engineActiveWorkspaces } from "./engine/engine-host-ipc";
import { keepRuntimeRunningWhile } from "./runtime-power";
import { registerSecurityAuditIpcHandlers } from "./security-audit-ipc";
import { WorkspaceWriterRegistry } from "./workspaces/workspace-writer-registry";
import { runtimeManagedPath } from "./workspace-runtime";
import { useAgentWorkspaceCheck } from "./preview-runtime/local/local-preview-idle.ts";

const agentWorkspaceWriters = new WorkspaceWriterRegistry();

export function registerAgentIpcHandlers() {
  // A preview stays up while an agent works in its worktree.
  useAgentWorkspaceCheck(localAgentOwnsWorkspace);
  // A git flow at work in the Blame Runtime keeps it running.
  keepRuntimeRunningWhile(() =>
    agentWorkspaceWriters
      .activeWorkspaces()
      .some((workspace) => runtimeManagedPath(workspace)),
  );
  registerSecurityAuditIpcHandlers((input) =>
    callEngineHost("mapSecurityAudit", input),
  );
  ipcMain.handle("agent:pull-request-availability", (_event, input) =>
    callEngineHost("pullRequestAvailability", input),
  );
  ipcMain.handle("agent:pull-request-state", (_event, input) =>
    callEngineHost("pullRequestState", input),
  );
  ipcMain.handle("agent:direct-story-files", (_event, input) =>
    callEngineHost("directStoryFiles", input),
  );
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

/**
 * A git flow the engine host runs itself (a story's Approve & Merge): what
 * main adds to it, as `engineGitFlowCall` does for a window's call. The
 * worktree counts as written until `endEngineGitFlow`.
 */
export async function beginEngineGitFlow(
  worktree: string,
  beforeDelivery: (worktree: string) => Promise<void>,
) {
  const flow = {
    inVm: runtimeManagedPath(worktree),
    activeWorktrees: [
      ...agentWorkspaceWriters.activeWorkspaces(),
      ...engineActiveWorkspaces(),
    ],
  };
  await beforeDelivery(worktree);
  const operation = `operation:${randomUUID()}`;
  agentWorkspaceWriters.begin(operation, worktree);
  return { ...flow, operation };
}

export function endEngineGitFlow(operation: string) {
  agentWorkspaceWriters.forget(operation);
}

async function runWorkspaceTask<T>(workspace: string, task: () => Promise<T>) {
  const operationId = `operation:${randomUUID()}`;
  agentWorkspaceWriters.begin(operationId, workspace);
  try {
    return await task();
  } finally {
    agentWorkspaceWriters.forget(operationId);
  }
}

export function localAgentOwnsWorkspace(worktree: string) {
  return (
    agentWorkspaceWriters.hasActiveWriter(worktree) ||
    engineActiveWorkspaces().includes(worktree)
  );
}
