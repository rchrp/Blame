// Stops local previews nobody uses, so a forgotten dev server does not
// keep its memory and file watchers. A preview is in use while the user
// views it, while an agent session runs in its worktree, and for a while
// after either last touched it. Opening it in the app or an agent's
// preview tool starts it again; the setup is done, so that takes seconds.

export const previewIdleTimeoutMs = 20 * 60_000;
const sweepIntervalMs = 60_000;

const lastUse = new Map<string, number>();
let agentWorksIn: (worktree: string) => boolean = () => false;
let sweeper: NodeJS.Timeout | undefined;

/** Records that the user, an agent or Blame itself used this preview. */
export function recordPreviewUse(worktree: string, now = Date.now()) {
  lastUse.set(worktree, now);
}

/** Tells whether an agent session currently runs in a worktree. */
export function useAgentWorkspaceCheck(check: (worktree: string) => boolean) {
  agentWorksIn = check;
}

/**
 * The running previews to stop: unused for the timeout, counted from their
 * last use or, for those already running, from when Blame started.
 */
export function idlePreviewWorktrees(input: {
  running: string[];
  busy: (worktree: string) => boolean;
  lastUse: ReadonlyMap<string, number>;
  since: number;
  now: number;
  timeoutMs?: number;
}) {
  const timeoutMs = input.timeoutMs ?? previewIdleTimeoutMs;
  return input.running.filter((worktree) => {
    if (input.busy(worktree)) return false;
    const used = Math.max(input.lastUse.get(worktree) ?? 0, input.since);
    return input.now - used >= timeoutMs;
  });
}

export function startIdlePreviewSweeper(dependencies: {
  runningWorktrees: () => Promise<string[]>;
  suspend: (worktree: string) => Promise<unknown>;
}) {
  if (sweeper) return;
  const since = Date.now();
  sweeper = setInterval(() => {
    void sweep(dependencies, since);
  }, sweepIntervalMs);
  sweeper.unref?.();
}

let sweeping = false;

async function sweep(
  dependencies: Parameters<typeof startIdlePreviewSweeper>[0],
  since: number,
) {
  if (sweeping) return;
  sweeping = true;
  try {
    const running = await dependencies.runningWorktrees().catch(() => []);
    // An agent at work keeps its preview in use, and for the timeout after.
    for (const worktree of running) {
      if (agentWorksIn(worktree)) recordPreviewUse(worktree);
    }
    const idle = idlePreviewWorktrees({
      running,
      busy: agentWorksIn,
      lastUse,
      since,
      now: Date.now(),
    });
    for (const worktree of idle) {
      await dependencies.suspend(worktree).catch(() => undefined);
      lastUse.delete(worktree);
    }
  } finally {
    sweeping = false;
  }
}
