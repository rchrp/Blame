import type { DeviceBuildResult } from "./types.ts";
export function mapBuildPath(file: string, mirror: string, worktree: string) {
  let path = file;
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      /* Preserve the compiler path. */
    }
  }
  // macOS reports /private/tmp and /private/var paths without "/private".
  const unprivate = (value: string) =>
    value.replace(/^\/private\/(tmp|var)\//, "/$1/");
  const prefix = unprivate(mirror.replace(/\\/g, "/").replace(/\/$/, ""));
  const normalized = unprivate(
    path.replace(/\\/g, "/").replace(/^\/([A-Za-z]:\/)/, "$1"),
  );
  const windows = /^[A-Za-z]:\//.test(prefix);
  return (windows ? normalized.toLowerCase() : normalized).startsWith(
    (windows ? prefix.toLowerCase() : prefix) + "/",
  )
    ? worktree.replace(/\/$/, "") + normalized.slice(prefix.length)
    : path;
}
export function parseBuildErrors(
  log: string,
  mirror: string,
  worktree: string,
) {
  const errors: Array<{ file?: string; line?: number; message: string }> = [];
  for (const line of log.split(/\r?\n/)) {
    const match =
      /^(?:e:\s*)?(.*?):(\d+)(?::\d+)?(?::|\s)+(?:\s*error:\s*)?(.*)$/.exec(
        line,
      );
    if (match && (/error:|^e:/.test(line) || /\.swift:/.test(line)))
      errors.push({
        file: mapBuildPath(match[1]!, mirror, worktree),
        line: Number(match[2]),
        message: match[3]!.slice(0, 2000),
      });
  }
  return errors.slice(0, 200);
}
export function failedDeviceBuild(
  log: string,
  mirror: string,
  worktree: string,
  issues: Array<{ file?: string; line?: number; message: string }> = [],
): DeviceBuildResult {
  // xcresult and the compiler log repeat the same diagnostic.
  const seen = new Set<string>();
  const errors = [...issues, ...parseBuildErrors(log, mirror, worktree)]
    .filter((error) => {
      const key = `${error.file}:${error.line}:${error.message.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 200);
  return {
    ok: false,
    summary:
      errors[0]?.message ??
      "The app could not be built. Fix the build errors and try again.",
    errors,
    logTail: mapBuildPath(log.slice(-16000), mirror, worktree)
      .split(mirror)
      .join(worktree),
  };
}

/** Modern xcresulttool build-results JSON, with legacy issue locations too. */
export function parseXcodeBuildIssues(
  value: unknown,
  mirror: string,
  worktree: string,
) {
  const errors: Array<{ file?: string; line?: number; message: string }> = [];
  const visit = (value: unknown, depth = 0) => {
    if (
      depth > 12 ||
      errors.length >= 200 ||
      !value ||
      typeof value !== "object"
    )
      return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 400)) visit(item, depth + 1);
      return;
    }
    const node = value as Record<string, any>;
    const message =
      typeof node.message === "string" ? node.message : node.message?._value;
    const location =
      node.sourceURL ??
      node.documentLocationInCreatingWorkspace?.url?._value ??
      node.documentLocationInCreatingWorkspace?.url;
    if (
      typeof message === "string" &&
      (typeof location === "string" || node.issueType)
    ) {
      let file: string | undefined, line: number | undefined;
      if (typeof location === "string") {
        const [path, fragment = ""] = location.split("#");
        file = mapBuildPath(path!, mirror, worktree);
        const number = new URLSearchParams(fragment).get("StartingLineNumber");
        // xcresult line numbers start at 0.
        if (number && /^\d+$/.test(number)) line = Number(number) + 1;
      }
      errors.push({ file, line, message: message.slice(0, 2000) });
    }
    for (const [key, child] of Object.entries(node))
      if (!/warning|note/i.test(key)) visit(child, depth + 1);
  };
  visit(value);
  return errors;
}
