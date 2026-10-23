import { createHash } from "node:crypto";
import ignore, { type Ignore } from "ignore";

// Which files of a cloud preview workspace are synchronized and hashed.
// The desktop and the sandbox runner must apply the same rule, or their
// workspace hashes drift apart and every incremental update is rejected.
//
// - "legacy": every file outside a fixed list of build and secret paths.
// - "gitignore-v1": additionally skips paths that the project's .gitignore
//   files exclude. Files a running app generates (an ORM client,
//   next-env.d.ts, *.tsbuildinfo, .nuxt...) then stay out of the hash, the
//   change journal and the deltas sent back to the local worktree.
//
// "gitignore-v1" also orders paths by UTF-16 code unit instead of
// localeCompare, whose order follows the process language (Czech sorts "ch"
// after "h", Danish puts "aa" last) and would differ from the sandbox.
//
// Only .gitignore files inside the workspace count: global excludes and
// .git/info/exclude differ between machines, and matching is case-sensitive
// as on the Linux sandbox. A .gitignore file itself is never skipped, so both
// sides always read the same rules.
export type WorkspaceSnapshotPolicy = "legacy" | "gitignore-v1";

export const currentWorkspaceSnapshotPolicy: WorkspaceSnapshotPolicy =
  "gitignore-v1";

export const workspaceSnapshotPolicies: readonly WorkspaceSnapshotPolicy[] = [
  "legacy",
  "gitignore-v1",
];

export const gitignoreFileName = ".gitignore";

export function parseWorkspaceSnapshotPolicy(
  value: unknown,
): WorkspaceSnapshotPolicy {
  return value === "gitignore-v1" ? "gitignore-v1" : "legacy";
}

/** Orders workspace paths as the policy's snapshot hash does. */
export function compareWorkspacePaths(policy: WorkspaceSnapshotPolicy) {
  if (policy === "legacy")
    return (left: string, right: string) => left.localeCompare(right);
  return (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
}

/** The workspace hash both the desktop and the sandbox runner compute. */
export function workspaceSnapshotHash(
  files: Record<string, unknown>,
  policy: WorkspaceSnapshotPolicy,
) {
  const hash = createHash("sha256");
  const compare = compareWorkspacePaths(policy);
  for (const [path, metadata] of Object.entries(files).sort(([left], [right]) =>
    compare(left, right),
  )) {
    hash
      .update(path)
      .update("\0")
      .update(JSON.stringify(metadata))
      .update("\0");
  }
  return hash.digest("hex");
}

type GitignoreRules = { directory: string; depth: number; matcher: Ignore };

export class WorkspaceIgnore {
  private readonly rules: GitignoreRules[] = [];

  constructor(readonly policy: WorkspaceSnapshotPolicy) {}

  /** Adds the rules of `<directory>/.gitignore`; "" is the workspace root. */
  add(directory: string, gitignore: string) {
    if (this.policy === "legacy") return;
    const normalized = normalizeDirectory(directory);
    this.rules.push({
      directory: normalized,
      depth: normalized ? normalized.split("/").length : 0,
      matcher: ignore({ ignorecase: false }).add(gitignore),
    });
    this.rules.sort((left, right) => left.depth - right.depth);
  }

  /**
   * Whether the rules exclude `path` itself. Callers that walk the tree skip
   * an excluded directory, so its contents never reach this check, as in Git.
   */
  ignores(path: string, directory = false) {
    if (this.policy === "legacy") return false;
    if (!directory && basename(path) === gitignoreFileName) return false;
    let ignored = false;
    for (const rule of this.rules) {
      const relative = relativeTo(rule.directory, path);
      if (!relative) continue;
      const result = rule.matcher.test(directory ? `${relative}/` : relative);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  }

  /** Like `ignores`, for a path whose parent directories were not checked. */
  ignoresWithAncestors(path: string, directory = false) {
    if (this.policy === "legacy") return false;
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (this.ignores(segments.slice(0, index).join("/"), true)) return true;
    }
    return this.ignores(path, directory);
  }
}

function normalizeDirectory(directory: string) {
  const value = directory
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+|^\/+|\/+$/g, "");
  return value === "." ? "" : value;
}

function relativeTo(directory: string, path: string) {
  if (!directory) return path;
  return path.startsWith(`${directory}/`)
    ? path.slice(directory.length + 1)
    : undefined;
}

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}
