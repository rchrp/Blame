import { open, stat } from "node:fs/promises";

// Reads the end of Blame's live log (`desktop-live-log.ts`) for the agent's
// `blame_inspect`: recent lines, optionally the ones holding a text, and how
// many errors the app logged lately. No Electron here, so it is testable.

const tailBytes = 1024 * 1024;
const errorScopes =
  /^\[[^\]]+\] \[(?:error|uncaughtException|unhandledRejection|renderer-process-gone)\]/;

/** The last `lines` lines (matching `search`), each already through `redact`. */
export async function readLiveLog(
  path: string,
  input: { lines: number; search?: string },
  redact: (line: string) => string = (line) => line,
) {
  const text = await readTail(path);
  const needle = input.search?.toLowerCase();
  const all = text
    .split("\n")
    .filter((line) => line.trim())
    .filter((line) => !needle || line.toLowerCase().includes(needle));
  return { total: all.length, lines: all.slice(-input.lines).map(redact) };
}

/** Errors logged in the last day, and the latest one. */
export async function liveLogErrors(
  path: string,
  redact: (line: string) => string = (line) => line,
  now = Date.now(),
) {
  const text = await readTail(path);
  const errors = text.split("\n").filter((line) => {
    if (!errorScopes.test(line)) return false;
    const at = Date.parse(line.slice(1, line.indexOf("]")));
    return Number.isFinite(at) && now - at < 24 * 60 * 60 * 1000;
  });
  const last = errors.at(-1);
  return {
    errors: errors.length,
    ...(last ? { lastError: redact(last).slice(0, 300) } : {}),
  };
}

async function readTail(path: string) {
  try {
    const size = (await stat(path)).size;
    const handle = await open(path, "r");
    try {
      const length = Math.min(size, tailBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      // A cut start leaves a partial first line.
      return size > length ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}
