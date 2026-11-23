// The file that holds the person's MCP servers (`mcp-settings.json`), read and
// written by two processes: the desktop's main process (Settings → MCP) and
// the engine host (OAuth tokens it refreshes while a conversation runs).
// This is the one place that touches it, so that neither can lose the other's
// changes or leave a half-written file:
//
// - every change is a read-modify-write under a lock file shared by both;
// - a rewrite goes to a temporary file, is flushed, then renamed over the old
//   one, so a crash leaves the old file or the new one, never half of each;
// - the content that is about to be replaced is first copied to a backup;
// - a file that cannot be read is moved aside, never overwritten, and the
//   person is told (a small notice file next to it);
// - a change that would leave the file without any server, while it held some,
//   is refused unless the caller says that is what the person asked for.
//
// Only node's own modules: the main process imports this file too.

import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type McpSettingsFile = {
  mcpServers: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

/** What was done about a file that could not be read. */
export type McpSettingsRecovery = {
  at: string;
  /** Where the unreadable file went; it is never deleted. */
  movedTo: string;
  /** The backup the servers came back from, when there was a usable one. */
  restoredFrom?: string;
};

export type McpSettingsReadOptions = {
  /** `quarantine` moves an unreadable file aside; `throw` leaves it alone. */
  unreadable?: "quarantine" | "throw";
};

export type McpSettingsUpdateOptions = McpSettingsReadOptions & {
  /** The person removed the last server: an empty list is expected. */
  allowEmpty?: boolean;
};

const BACKUP_KEEP = 10;
const BACKUP_EVERY_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 10 * 1000;

export class McpSettingsUnreadableError extends Error {
  constructor(path: string, cause: unknown) {
    super(`The MCP settings file ${path} cannot be read.`, { cause });
    this.name = "McpSettingsUnreadableError";
  }
}

export function mcpSettingsBackupDirectory(path: string) {
  return join(dirname(path), "mcp-settings-backups");
}

function recoveryNoticePath(path: string) {
  return `${path}.recovered.json`;
}

/** Reads the file: a missing one is an empty list, an unreadable one is not. */
export async function readMcpSettings(
  path: string,
  options: McpSettingsReadOptions = {},
): Promise<McpSettingsFile> {
  const text = await readText(path);
  if (text === undefined) return { mcpServers: {} };
  const parsed = parseSettings(text);
  if (parsed) return parsed;
  if (options.unreadable === "quarantine") return quarantine(path);
  throw new McpSettingsUnreadableError(path, "invalid content");
}

/**
 * Changes the file under the lock. `mutate` gets the current content and
 * returns the next one (or changes it in place and returns nothing). Nothing is
 * written when the result is the same as what is on disk.
 */
export function updateMcpSettings(
  path: string,
  mutate: (
    settings: McpSettingsFile,
  ) => McpSettingsFile | void | Promise<McpSettingsFile | void>,
  options: McpSettingsUpdateOptions = {},
): Promise<McpSettingsFile> {
  return withFileLock(path, async () => {
    const current = await readMcpSettings(path, options);
    const before = JSON.stringify(current);
    const draft = JSON.parse(before) as McpSettingsFile;
    const next = (await mutate(draft)) ?? draft;
    if (!isSettings(next)) throw new Error("Invalid MCP settings");
    if (
      !options.allowEmpty &&
      Object.keys(next.mcpServers).length === 0 &&
      Object.keys(current.mcpServers).length > 0
    ) {
      throw new Error(
        "Refusing to remove every MCP server from the settings file.",
      );
    }
    if (JSON.stringify(next) === before) return current;
    await backupBeforeRewrite(path, current);
    await writeAtomically(path, next);
    return next;
  });
}

/** A file that was set aside the last time it was read, until dismissed. */
export async function readMcpSettingsRecovery(
  path: string,
): Promise<McpSettingsRecovery | undefined> {
  const text = await readText(recoveryNoticePath(path));
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) && typeof value.movedTo === "string"
      ? (value as McpSettingsRecovery)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function clearMcpSettingsRecovery(path: string) {
  await rm(recoveryNoticePath(path), { force: true });
}

/** The newest backup that holds at least one server, for a manual restore. */
export async function latestMcpSettingsBackup(
  path: string,
): Promise<string | undefined> {
  for (const file of await backupFiles(path)) {
    const text = await readText(file);
    const parsed = text === undefined ? undefined : parseSettings(text);
    if (parsed && Object.keys(parsed.mcpServers).length > 0) return file;
  }
  return undefined;
}

async function quarantine(path: string): Promise<McpSettingsFile> {
  const at = new Date().toISOString();
  const movedTo = `${path}.unreadable-${at.replace(/[:.]/g, "-")}`;
  await rename(path, movedTo);
  const restoredFrom = await latestMcpSettingsBackup(path);
  let settings: McpSettingsFile = { mcpServers: {} };
  if (restoredFrom) {
    const text = await readText(restoredFrom);
    const parsed = text === undefined ? undefined : parseSettings(text);
    if (parsed) {
      settings = parsed;
      await writeAtomically(path, parsed);
    }
  }
  const notice: McpSettingsRecovery = {
    at,
    movedTo,
    ...(restoredFrom && Object.keys(settings.mcpServers).length
      ? { restoredFrom }
      : {}),
  };
  await writeFile(recoveryNoticePath(path), `${JSON.stringify(notice)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return settings;
}

async function backupBeforeRewrite(path: string, current: McpSettingsFile) {
  // An empty file has nothing worth keeping; a backup of it would only push
  // the useful ones out of the ring.
  if (Object.keys(current.mcpServers).length === 0) return;
  const directory = mcpSettingsBackupDirectory(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await backupFiles(path);
  const newest = existing[0];
  if (newest) {
    const age = Date.now() - (await stat(newest)).mtimeMs;
    // Rapid rewrites keep the first backup: the state before them.
    if (age < BACKUP_EVERY_MS) return;
  }
  const name = `${basename(path)}.${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const target = join(directory, name);
  await copyFile(path, target);
  await chmod(target, 0o600).catch(() => undefined);
  for (const old of existing.slice(BACKUP_KEEP - 1)) {
    await unlink(old).catch(() => undefined);
  }
}

/** Newest first. */
async function backupFiles(path: string) {
  const directory = mcpSettingsBackupDirectory(path);
  const prefix = `${basename(path)}.`;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .reverse()
    .map((name) => join(directory, name));
}

async function writeAtomically(path: string, settings: McpSettingsFile) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  if (process.platform !== "win32") await chmod(path, 0o600);
}

async function withFileLock<T>(path: string, run: () => Promise<T>) {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await lockIsStale(lock)) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new Error("The MCP settings file is in use. Try again.");
      await new Promise((resolve) =>
        setTimeout(resolve, 15 + Math.random() * 30),
      );
    }
  }
  try {
    return await run();
  } finally {
    await rm(lock, { force: true });
  }
}

async function lockIsStale(lock: string) {
  try {
    const info = await stat(lock);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true;
    const pid = Number((await readFile(lock, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    // Gone between the two calls: not stale, the next try takes it.
    return false;
  }
}

async function readText(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseSettings(text: string): McpSettingsFile | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isSettings(parsed)
      ? ({ ...parsed, mcpServers: { ...parsed.mcpServers } } as McpSettingsFile)
      : undefined;
  } catch {
    return undefined;
  }
}

function isSettings(value: unknown): value is McpSettingsFile {
  return isRecord(value) && isRecord(value.mcpServers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
