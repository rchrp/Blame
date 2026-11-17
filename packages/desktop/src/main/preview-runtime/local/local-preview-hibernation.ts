import { resolveWorkspacePath } from "../../workspace-runtime.ts";
import { recordPreviewUse } from "./local-preview-idle.ts";
import {
  localDockerHost,
  localPreviewEngine,
  localPreviewUrl,
} from "./local-preview-runner.ts";
import {
  hibernateScript,
  parseHibernation,
  parseWake,
  pausedPreviewsScript,
  parsePausedPreviews,
  unpauseScript,
  wakeRestartReason,
  wakeScript,
  watchScript,
} from "./local-preview-hibernation-scripts.ts";

// Hibernates a local preview nobody uses: its containers are paused, so
// they use no CPU, and their memory goes to swap, so other previews and
// agents get it. Every access goes through ensureLocalPreviewAwake first:
// the agent's preview tools, the in-app browser's bridge, surfaces, the
// app's controls. Clients that reach the port directly (an external
// browser, a device, an agent's curl or database client) are seen by a
// watcher in the Docker host. Waking takes a fraction of a second; the
// first request then takes a second or two while memory comes back.
// Docker is the truth: a paused container means a hibernated preview,
// also after Blame restarted.

type Hibernation = {
  projectName: string;
  marker: string;
  pids: number[];
  containers: number;
  since: number;
};

type HibernationHooks = {
  log: (worktree: string, line: string) => void;
  /** Starts the preview again from its current files. */
  restart: (worktree: string) => Promise<unknown>;
};

const hibernations = new Map<string, Hibernation>();
const queues = new Map<string, Promise<unknown>>();
let hooks: HibernationHooks = {
  log: () => undefined,
  restart: async () => undefined,
};

export function configureLocalPreviewHibernation(next: HibernationHooks) {
  hooks = next;
}

export function localPreviewHibernated(worktree: string) {
  return hibernations.has(resolveWorkspacePath(worktree));
}

/**
 * Wakes the preview if it hibernates, and waits until it answers again;
 * an awake preview costs nothing more than a map lookup. `recordUse`
 * false is for traffic that may come from a hidden page, which should not
 * keep a preview awake by itself.
 */
export async function ensureLocalPreviewAwake(
  worktreeInput: string,
  reason: string,
  options: { recordUse?: boolean } = {},
) {
  const worktree = resolveWorkspacePath(worktreeInput);
  if (options.recordUse !== false) recordPreviewUse(worktree);
  // Right after Blame started, a paused preview may not be known yet.
  if (!adopted) await adoptPausedLocalPreviews();
  if (!hibernations.has(worktree) && !queues.has(worktree)) return;
  await serialized(worktree, () => wake(worktree, reason));
}

/** Pauses an unused preview and evicts its memory. */
export async function hibernateLocalPreview(worktree: string) {
  return serialized(worktree, async () => {
    if (hibernations.has(worktree)) return undefined;
    const project = await localPreviewEngine(worktree).prepared();
    if (!project) return undefined;
    const marker = markerPath(project.projectName);
    const startedAt = Date.now();
    const result = await localDockerHost().run(
      "sh",
      ["-c", hibernateScript, "sh", project.projectName, marker],
      { timeoutMs: 60_000 },
    );
    if (result.exitCode === 3) return undefined;
    const containers = parseHibernation(result.stdout);
    if (result.exitCode !== 0 || !containers.length) {
      await unpause(project.projectName);
      throw new Error(
        `The preview could not be hibernated: ${result.stderr.trim() || `exit code ${result.exitCode}`}`,
      );
    }
    hibernations.set(worktree, {
      projectName: project.projectName,
      marker,
      pids: containers.map(({ pid }) => pid).filter((pid) => pid > 0),
      containers: containers.length,
      since: Date.now(),
    });
    refreshWatcher();
    const before = containers.reduce((sum, c) => sum + c.memoryBefore, 0);
    const after = containers.reduce((sum, c) => sum + c.memoryAfter, 0);
    hooks.log(
      worktree,
      `preview hibernated in ${Date.now() - startedAt} ms: ${mebibytes(before)} → ${mebibytes(after)} MiB in ${containers.length} containers`,
    );
    return { before, after };
  });
}

/**
 * Unpauses a preview about to be stopped or removed, without waiting for
 * it to answer. Safe to call from inside a wake's restart.
 */
export async function releaseLocalPreviewHibernation(worktree: string) {
  const hibernation = hibernations.get(worktree);
  if (!hibernation) return;
  hibernations.delete(worktree);
  refreshWatcher();
  await unpause(hibernation.projectName);
}

/**
 * Takes over the previews left paused by an earlier Blame (it crashed, or
 * on Linux it quit while Docker kept running), so their next use wakes them.
 */
let adopted = false;
let adoption: Promise<void> | undefined;
let lastAdoptionAttempt = 0;

/** Tries until it succeeds, at most every 10 seconds; then never again. */
export function adoptPausedLocalPreviews() {
  if (adopted || Date.now() - lastAdoptionAttempt < 10_000) return adoption;
  lastAdoptionAttempt = Date.now();
  adoption = adoptNow().finally(() => (adoption = undefined));
  return adoption;
}

async function adoptNow() {
  const result = await localDockerHost()
    .run("sh", ["-c", pausedPreviewsScript], { timeoutMs: 30_000 })
    .catch(() => undefined);
  if (result?.exitCode !== 0) return;
  adopted = true;
  for (const paused of parsePausedPreviews(result.stdout)) {
    if (hibernations.has(paused.worktree)) continue;
    hibernations.set(paused.worktree, {
      ...paused,
      marker: markerPath(paused.projectName),
      since: Date.now(),
    });
  }
  refreshWatcher();
}

async function wake(worktree: string, reason: string) {
  const hibernation = hibernations.get(worktree);
  if (!hibernation) return;
  const startedAt = Date.now();
  const result = await localDockerHost().run(
    "sh",
    [
      "-c",
      wakeScript,
      "sh",
      hibernation.projectName,
      hibernation.marker,
      worktree,
    ],
    { timeoutMs: 120_000 },
  );
  hibernations.delete(worktree);
  refreshWatcher();
  recordPreviewUse(worktree);
  const report = parseWake(result.stdout);
  const restart =
    result.exitCode !== 0
      ? `its containers could not be unpaused (${result.stderr.trim() || result.exitCode})`
      : wakeRestartReason(report, hibernation.containers);
  const slept = Math.round((startedAt - hibernation.since) / 60_000);
  if (restart) {
    hooks.log(
      worktree,
      `preview woken for ${reason} after ${slept} min; restarting it because ${restart}`,
    );
    await hooks.restart(worktree);
    return;
  }
  const unpausedMs = Date.now() - startedAt;
  await waitUntilAnswering(worktree);
  hooks.log(
    worktree,
    `preview woken for ${reason} after ${slept} min: unpaused in ${unpausedMs} ms, answering after ${Date.now() - startedAt} ms (${report.changed ?? 0} files changed)`,
  );
}

const answerTimeoutMs = 60_000;

async function waitUntilAnswering(worktree: string) {
  const url = await localPreviewUrl(worktree).catch(() => undefined);
  if (!url) return;
  const deadline = Date.now() + answerTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status < 500) return;
    } catch {
      // Not listening yet, or the request timed out: try again.
    }
    await delay(250);
  }
}

// Hibernating, waking and releasing one preview never overlap; a wake
// asked during a hibernation runs right after it.
function serialized<T>(worktree: string, action: () => Promise<T>) {
  const previous = queues.get(worktree) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  const settled = next.finally(() => {
    if (queues.get(worktree) === settled) queues.delete(worktree);
  });
  queues.set(worktree, settled);
  return next;
}

async function unpause(projectName: string) {
  await localDockerHost()
    .run("sh", ["-c", unpauseScript, "sh", projectName], { timeoutMs: 60_000 })
    .catch(() => undefined);
}

function markerPath(projectName: string) {
  return `/tmp/blame-hibernation-${projectName}`;
}

function mebibytes(bytes: number) {
  return Math.round(bytes / 1_048_576);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// One watcher for every hibernated preview, restarted when the set changes.
const watcherTicks = 600;
let watcher: { key: string; controller: AbortController } | undefined;
let watcherRetry: NodeJS.Timeout | undefined;

function refreshWatcher() {
  const owners = new Map<number, string>();
  for (const [worktree, { pids }] of hibernations)
    for (const pid of pids) owners.set(pid, worktree);
  const key = [...owners.keys()].sort((a, b) => a - b).join(" ");
  if (watcher?.key === key) return;
  watcher?.controller.abort();
  watcher = undefined;
  clearTimeout(watcherRetry);
  if (!owners.size) return;
  const controller = new AbortController();
  const current = { key, controller };
  watcher = current;
  const startedAt = Date.now();
  let pending = "";
  void localDockerHost()
    .run(
      "sh",
      [
        "-c",
        watchScript,
        "sh",
        "/proc",
        String(watcherTicks),
        ...key.split(" "),
      ],
      {
        signal: controller.signal,
        onOutput: (chunk) => {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            const worktree = owners.get(Number(line.replace(/^wake /, "")));
            if (!line.startsWith("wake ") || !worktree) continue;
            void ensureLocalPreviewAwake(
              worktree,
              "a connection to its port",
            ).catch(() => undefined);
          }
        },
      },
    )
    .catch(() => undefined)
    .finally(() => {
      if (watcher !== current) return;
      watcher = undefined;
      // Its bounded life ran out: watch again. A watcher that failed at
      // once waits before the next try.
      watcherRetry = setTimeout(
        refreshWatcher,
        Date.now() - startedAt < 5_000 ? 30_000 : 0,
      );
      watcherRetry.unref?.();
    });
}
