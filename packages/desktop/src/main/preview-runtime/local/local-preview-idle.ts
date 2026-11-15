// Puts local previews nobody uses to sleep, in two steps. After a few
// minutes without use a preview hibernates: its containers are paused and
// their memory evicted, and its next use wakes it in a second or two (see
// local-preview-hibernation.ts). After a couple of hours it is stopped, which
// also frees its swap and file watchers; opening it starts it again, which
// takes seconds since the setup is done. Use is a state read from a visible
// window, an agent's preview tool, the in-app browser, a surface, or a
// client connecting to its port. An agent coding in the worktree does not
// keep its preview awake (it wakes on the agent's next look), but keeps it
// from being stopped: the user usually reviews it once the agent is done.

export const previewHibernateAfterMs = 5 * 60_000;
export const previewIdleTimeoutMs = 2 * 60 * 60_000;
const sweepIntervalMs = 60_000;

const lastUse = new Map<string, number>();
const lastAgentWork = new Map<string, number>();
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
 * The running previews unused for the timeout, counted from their last
 * use or, for those already running, from when Blame started.
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

/** What the sweep does to each running preview. */
export function idlePreviewActions(input: {
  running: string[];
  hibernated: (worktree: string) => boolean;
  agentWorksIn: (worktree: string) => boolean;
  lastUse: ReadonlyMap<string, number>;
  lastAgentWork: ReadonlyMap<string, number>;
  since: number;
  now: number;
}) {
  const stop = idlePreviewWorktrees({
    running: input.running,
    busy: input.agentWorksIn,
    lastUse: new Map(
      input.running.map((worktree) => [
        worktree,
        Math.max(
          input.lastUse.get(worktree) ?? 0,
          input.lastAgentWork.get(worktree) ?? 0,
        ),
      ]),
    ),
    since: input.since,
    now: input.now,
    timeoutMs: previewIdleTimeoutMs,
  });
  const hibernate = idlePreviewWorktrees({
    running: input.running.filter(
      (worktree) => !stop.includes(worktree) && !input.hibernated(worktree),
    ),
    busy: () => false,
    lastUse: input.lastUse,
    since: input.since,
    now: input.now,
    timeoutMs: previewHibernateAfterMs,
  });
  return { hibernate, stop };
}

export function startIdlePreviewSweeper(dependencies: {
  runningWorktrees: () => Promise<string[]>;
  hibernated: (worktree: string) => boolean;
  hibernate: (worktree: string) => Promise<unknown>;
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
    const now = Date.now();
    for (const worktree of running) {
      if (agentWorksIn(worktree)) lastAgentWork.set(worktree, now);
    }
    const { hibernate, stop } = idlePreviewActions({
      running,
      hibernated: dependencies.hibernated,
      agentWorksIn,
      lastUse,
      lastAgentWork,
      since,
      now,
    });
    for (const worktree of stop) {
      await dependencies.suspend(worktree).catch(() => undefined);
      lastUse.delete(worktree);
      lastAgentWork.delete(worktree);
    }
    for (const worktree of hibernate) {
      await dependencies.hibernate(worktree).catch(() => undefined);
    }
  } finally {
    sweeping = false;
  }
}
