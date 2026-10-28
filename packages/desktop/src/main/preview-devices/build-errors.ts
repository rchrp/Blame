import type { DeviceBuildResult } from "./types.ts";
export function mapBuildPath(file: string, mirror: string, worktree: string) {
  let path = file;
  if (path.startsWith("file://")) { try { path = decodeURIComponent(new URL(path).pathname); } catch { /* Preserve the compiler path. */ } }
  const prefix = mirror.replace(/\\/g, "/").replace(/\/$/, "");
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(prefix + "/") ? worktree.replace(/\/$/, "") + normalized.slice(prefix.length) : path;
}
export function parseBuildErrors(log: string, mirror: string, worktree: string) {
  const errors: Array<{ file?: string; line?: number; message: string }> = [];
  for (const line of log.split(/\r?\n/)) {
    const match = /^(?:e:\s*)?(.*?):(\d+)(?::\d+)?(?::|\s)+(?:\s*error:\s*)?(.*)$/.exec(line);
    if (match && (/error:|^e:/.test(line) || /\.swift:/.test(line))) errors.push({ file: mapBuildPath(match[1]!, mirror, worktree), line: Number(match[2]), message: match[3]!.slice(0, 2000) });
  }
  return errors.slice(0, 200);
}
export function failedDeviceBuild(log: string, mirror: string, worktree: string): DeviceBuildResult {
  const errors = parseBuildErrors(log, mirror, worktree);
  return { ok: false, summary: errors[0]?.message ?? "The app could not be built. Fix the build errors and try again.", errors, logTail: mapBuildPath(log.slice(-16000), mirror, worktree).split(mirror).join(worktree) };
}
