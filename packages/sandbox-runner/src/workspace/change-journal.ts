import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  workspaceSnapshotHash,
  type WorkspaceSnapshotPolicy,
} from "@blame/preview-runtime/workspace-ignore";
import { runtimePaths } from "../runtime-paths.js";
import {
  snapshotWorkspace,
  type WorkspaceFileSnapshot,
  type WorkspaceSnapshot,
} from "./workspace-snapshot.js";

// The journal tracks the workspace as the local worktree last sent it, plus
// changes a remote writer made since (exported back to the local worktree).
//
// Tools also write synchronized files while the preview runs: a migration
// rewrites db/schema.rb, an install touches a lockfile, a framework completes
// tsconfig.json. Without a remote writer those are not work to bring back, so
// the journal keeps them as drift: each such path with the version the local
// worktree sent and the one the sandbox now has (null when absent). Hashes,
// deltas and exports use that "local view", so drift neither blocks incoming
// deltas nor reaches the local worktree, and a newer local version of a path
// always replaces it.
export type DriftEntry = {
  local: WorkspaceFileSnapshot | null;
  sandbox: WorkspaceFileSnapshot | null;
};
export type JournalDrift = Record<string, DriftEntry>;

export type ChangeJournalState = {
  revision: number;
  base: WorkspaceSnapshot;
  current: WorkspaceSnapshot;
  drift?: JournalDrift;
  updatedAt: string;
};

/** The workspace with drifted paths shown as the local worktree sent them. */
export function localView(
  snapshot: WorkspaceSnapshot,
  drift: JournalDrift = {},
  policy: WorkspaceSnapshotPolicy = snapshot.policy ?? "legacy",
): WorkspaceSnapshot {
  if (!Object.keys(drift).length && policy === (snapshot.policy ?? "legacy"))
    return snapshot;
  const files = { ...snapshot.files };
  for (const [path, { local }] of Object.entries(drift)) {
    if (local) files[path] = local;
    else delete files[path];
  }
  return { hash: workspaceSnapshotHash(files, policy), files, policy };
}

export async function initializeChangeJournal(drift: JournalDrift = {}) {
  return withJournalLock(async () => {
    const view = localView(await snapshotWorkspace(), drift);
    const state = {
      revision: 0,
      base: view,
      current: view,
      drift,
      updatedAt: new Date().toISOString(),
    } satisfies ChangeJournalState;
    await writeJournal(state);
    return state;
  });
}

/**
 * Records workspace changes. Only changes made while a remote writer runs
 * (`attribute`) become exportable work; others become drift.
 */
export async function checkpointChangeJournal(
  options: { attribute?: boolean } = {},
) {
  return withJournalLock(async () => {
    const actual = await snapshotWorkspace();
    const state = await readChangeJournal().catch((): ChangeJournalState => ({
      revision: 0,
      base: actual,
      current: actual,
      updatedAt: new Date().toISOString(),
    }));
    const previousDrift = state.drift ?? {};
    const drift = options.attribute
      ? attributedDrift(previousDrift, actual)
      : absorbedDrift(previousDrift, actual, state.current);
    const view = localView(actual, drift);
    const driftChanged = JSON.stringify(drift) !== JSON.stringify(previousDrift);
    if (state.current.hash !== view.hash || driftChanged) {
      if (state.current.hash !== view.hash) state.revision += 1;
      state.current = view;
      state.drift = drift;
      state.updatedAt = new Date().toISOString();
      await writeJournal(state);
    }
    return state;
  });
}

// Unattributed changes join the drift; a drifted path that returns to its
// local version leaves it.
function absorbedDrift(
  drift: JournalDrift,
  actual: WorkspaceSnapshot,
  known: WorkspaceSnapshot,
) {
  const next: JournalDrift = {};
  for (const [path, entry] of Object.entries(drift)) {
    const sandbox = actual.files[path] ?? null;
    if (!sameFile(sandbox ?? undefined, entry.local ?? undefined))
      next[path] = { local: entry.local, sandbox };
  }
  const paths = new Set([...Object.keys(actual.files), ...Object.keys(known.files)]);
  for (const path of paths) {
    if (path in drift) continue;
    if (!sameFile(actual.files[path], known.files[path])) {
      next[path] = {
        local: known.files[path] ?? null,
        sandbox: actual.files[path] ?? null,
      };
    }
  }
  return next;
}

// A remote writer that changes a drifted path makes it its own work.
function attributedDrift(drift: JournalDrift, actual: WorkspaceSnapshot) {
  const next: JournalDrift = {};
  for (const [path, entry] of Object.entries(drift)) {
    if (sameFile(actual.files[path], entry.sandbox ?? undefined)) next[path] = entry;
  }
  return next;
}

export function sameFile(
  left: WorkspaceFileSnapshot | undefined,
  right: WorkspaceFileSnapshot | undefined,
) {
  if (!left || !right) return left === right;
  return (
    left.type === right.type &&
    left.sha256 === right.sha256 &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.target === right.target
  );
}

export async function readChangeJournal(): Promise<ChangeJournalState> {
  return JSON.parse(await readFile(runtimePaths.journal, "utf8")) as ChangeJournalState;
}

export async function acknowledgeChangeJournal(revision: string) {
  return withJournalLock(async () => {
    const state = await readChangeJournal();
    if (String(state.revision) !== revision) {
      throw new Error("Only the latest exported workspace revision can be acknowledged.");
    }
    state.base = state.current;
    state.updatedAt = new Date().toISOString();
    await writeJournal(state);
    return state;
  });
}

export async function watchChangeJournal() {
  while (true) {
    try {
      await checkpointChangeJournal();
    } catch {}
    await delay(2_000);
  }
}

async function writeJournal(state: ChangeJournalState) {
  await mkdir(dirname(runtimePaths.journal), { recursive: true, mode: 0o700 });
  const temporary = `${runtimePaths.journal}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flush: true });
  await rename(temporary, runtimePaths.journal);
}

async function withJournalLock<T>(operation: () => Promise<T>) {
  await mkdir(dirname(runtimePaths.journalLock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const lock = await open(runtimePaths.journalLock, "wx", 0o600);
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        await lock.sync();
        return await operation();
      } finally {
        await lock.close();
        await rm(runtimePaths.journalLock, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await recoverStaleJournalLock();
      await delay(20);
    }
  }
  throw new Error("Change journal lock timed out.");
}

async function recoverStaleJournalLock() {
  try {
    const [content, metadata] = await Promise.all([
      readFile(runtimePaths.journalLock, "utf8"),
      stat(runtimePaths.journalLock),
    ]);
    const owner = JSON.parse(content) as { pid?: unknown; createdAt?: unknown };
    const pid = Number(owner.pid);
    const createdAt = Number(owner.createdAt);
    const implausiblyOld = Date.now() - Math.min(createdAt || metadata.mtimeMs, metadata.mtimeMs) > 10 * 60_000;
    if (!Number.isSafeInteger(pid) || pid < 1 || !processAlive(pid) || implausiblyOld) {
      await rm(runtimePaths.journalLock, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    const metadata = await stat(runtimePaths.journalLock).catch(() => undefined);
    if (metadata && Date.now() - metadata.mtimeMs > 30_000) {
      await rm(runtimePaths.journalLock, { force: true });
    }
  }
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
