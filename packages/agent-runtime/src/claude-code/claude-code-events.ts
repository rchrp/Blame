import { appendFile, rename, stat } from "node:fs/promises";

/** Records what happens to Claude Code processes: starts, cuts, retries, stalls, closes. */
export type LaneLog = (event: string, details: Record<string, unknown>) => void;

const maxLogBytes = 4 * 1024 * 1024;

/**
 * Appends one JSON line per event, so a replayed or restarted conversation
 * can be explained afterwards. The file rolls over to `.1` past 4 MiB.
 */
export function laneEventLog(path: string): LaneLog {
  let pending = Promise.resolve();
  return (event, details) => {
    const line = `${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`;
    pending = pending.then(() => append(path, line)).catch(() => undefined);
  };
}

async function append(path: string, line: string) {
  const size = await stat(path).then((file) => file.size, () => 0);
  if (size > maxLogBytes) await rename(path, `${path}.1`);
  await appendFile(path, line, { mode: 0o600 });
}
