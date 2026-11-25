import { execFile } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { constants as osConstants, setPriority, tmpdir } from "node:os";
import { basename, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { pLimit } from "./concurrency.ts";
import { hostGitCommand } from "./host-git.ts";
import { workspaceDiffStats } from "./workspace-diff-stats.ts";
import { ignoredGitDiffPathspecs } from "./workspace-diff-policy.ts";
import {
  resolveWorkspacePath,
  run as runRuntime,
  runtimeManagedPath,
} from "./workspace-runtime.ts";
import {
  ensureRuntimeGitSafeDirectory,
  runRuntimeGit,
} from "./workspace-runtime-git.ts";
import type { WorkspaceExecution } from "./workspace-mode.ts";

const execFileAsync = promisify(execFile);
const maxBuffer = 50 * 1024 * 1024;
const gitReadLimit = pLimit(6);

export function storyWorktreeAddArguments(input: {
  branch: string;
  existing: boolean;
  // The last commit of the story's target branch; HEAD without one.
  startPoint: string;
  worktree: string;
}) {
  const args = ["worktree", "add", "--lock", "--reason", "Managed by Blame"];
  return input.existing
    ? [...args, input.worktree, input.branch]
    : [...args, "-b", input.branch, input.worktree, input.startPoint];
}

export function storyWorktreeRemoveArguments(worktree: string) {
  // Intentional disposal must also remove the lock protecting VM worktrees
  // from host-side maintenance while they are active.
  return ["worktree", "remove", "--force", "--force", worktree];
}

export function gitLogArguments(input: {
  currentBranchOnly?: boolean;
  limit?: number;
  skip?: number;
}) {
  const limit = Math.max(1, Math.min(input.limit ?? 200, 5_000));
  const skip = Math.max(0, input.skip ?? 0);
  return [
    "log",
    input.currentBranchOnly ? "HEAD" : "--all",
    // Children before parents, which the commit graph's lanes rely on.
    "--date-order",
    "--decorate=short",
    `--max-count=${limit}`,
    `--skip=${skip}`,
    "--date=iso-strict",
    "--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%D%x1f%s%x1e",
  ];
}

type GitRunner = (
  root: string,
  args: string[],
  environment?: Record<string, string>,
) => Promise<{ stderr: string; stdout: string }>;

export type GitDirectoryInput = {
  path?: string;
  refs: string[];
  root: string;
};

export type GitFileInput = GitDirectoryInput & {
  path: string;
};

export type GitDiffInput = {
  from: string;
  root: string;
  to: string;
};

export type GitDiffFromInput = Omit<GitDiffInput, "to">;

export type GitSnapshotInput = {
  id: string;
  root: string;
};

export async function gitSnapshot(input: GitSnapshotInput) {
  if (!/^[0-9a-z._-]+$/i.test(input.id)) throw new Error("Invalid snapshot id");
  return withSnapshotIndex(input.root, async (index) => {
    const ref = await createSnapshotTree(input.root, index);
    await updateSnapshotRef(input.root, input.id, ref);
    return ref;
  });
}

// A throwaway Git index next to the repository: on the host, or inside
// BlameRuntime when the worktree lives there.
async function withSnapshotIndex<T>(
  root: string,
  use: (index: string) => Promise<T>,
) {
  if (!runtimeManagedPath(root)) {
    const directory = await mkdtemp(join(tmpdir(), "blame-git-snapshot-"));
    try {
      return await use(join(directory, "index"));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
  // Also sets up Git access to the worktree before the env-wrapped calls.
  await runRuntimeGit(root, ["rev-parse", "--git-dir"]);
  const { stdout } = await runRuntime(
    "mktemp",
    ["-d", "/tmp/blame-git-snapshot-XXXXXX"],
    { execution: "virtualized" },
  );
  const directory = stdout.trim();
  try {
    return await use(posix.join(directory, "index"));
  } finally {
    await runRuntime("rm", ["-rf", directory], {
      execution: "virtualized",
    }).catch(() => undefined);
  }
}

async function createSnapshotTree(root: string, index: string) {
  const environment = { GIT_INDEX_FILE: index };
  await runBackgroundGit(root, ["read-tree", "HEAD"], environment);
  const trackedEnvFiles = await trackedRuntimeEnvPaths(
    root,
    environment,
    runBackgroundGit,
  );
  if (trackedEnvFiles.length) {
    await runBackgroundGit(
      root,
      ["rm", "--cached", "--ignore-unmatch", "--", ...trackedEnvFiles],
      environment,
    );
  }
  const excludedEnvFiles = await changedRuntimeEnvPathspecs(
    root,
    runBackgroundGit,
  );
  await runBackgroundGit(
    root,
    ["add", "-A", "--", ".", ...excludedEnvFiles],
    environment,
  );
  const { stdout } = await runBackgroundGit(root, ["write-tree"], environment);
  return stdout.trim();
}

async function updateSnapshotRef(root: string, id: string, ref: string) {
  await runBackgroundGit(root, [
    "update-ref",
    `refs/blame/agent-runs/${id}`,
    ref,
  ]);
}

// A worktree's diff from a revision, polled while its Diff tab shows. New
// files show as added through intent-to-add entries in a copy of the index,
// and an attribute leaves runtime env files out (as runtimeEnvPath does):
// one diff for the whole worktree, whatever the number of new files. The
// copy and the attributes live in the worktree's Git directory.
const workingDiffAttributes = [
  ".env blame-env",
  ".env.* blame-env",
  "*.example -blame-env",
  "*.sample -blame-env",
  "*.template -blame-env",
].join("\n");
// Naming an ignored path, such as .blame, would fail the add. The add
// fills a scratch index only, so it takes every file: an older git (the
// runtime VM's 2.43) refuses the attr magic in `add`, and the diff leaves
// the env files out by their attribute.
export const workingDiffAddPathspecs = ["."];
const workingDiffPathspecs = [
  ".",
  ":(exclude,attr:blame-env)",
  ...ignoredGitDiffPathspecs,
];
const workingDiffScript = `set -e
git_dir=$(git rev-parse --absolute-git-dir)
attributes="$git_dir/blame-diff-attributes"
index="$git_dir/blame-diff-index"
printf '%s\\n' "$1" > "$attributes"
from=$2
shift 2
if [ -f "$git_dir/index" ]; then cp "$git_dir/index" "$index"; else rm -f "$index"; fi
export GIT_INDEX_FILE="$index"
git -c core.attributesFile="$attributes" add --intent-to-add -- ${workingDiffAddPathspecs.map(shellQuote).join(" ")}
exec git -c core.attributesFile="$attributes" diff --no-ext-diff "$from" -- "$@"
`;
// Diffs of a worktree share its index copy: one at a time.
const workingDiffs = new Map<string, Promise<unknown>>();

export function gitDiffFrom(input: GitDiffFromInput) {
  const from = revision(input.from);
  const previous = workingDiffs.get(input.root) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => workingDiff(input.root, from));
  workingDiffs.set(input.root, next);
  void next
    .finally(() => {
      if (workingDiffs.get(input.root) === next)
        workingDiffs.delete(input.root);
    })
    .catch(() => undefined);
  return next;
}

async function workingDiff(root: string, from: string) {
  if (runtimeManagedPath(root)) {
    await ensureRuntimeGitSafeDirectory(root);
    const { stdout } = await runRuntime(
      "sh",
      [
        "-c",
        workingDiffScript,
        "sh",
        workingDiffAttributes,
        from,
        ...workingDiffPathspecs,
      ],
      { cwd: root, execution: "virtualized", maxBuffer },
    );
    return stdout;
  }
  const { stdout: gitDirectory } = await runGit(root, [
    "rev-parse",
    "--absolute-git-dir",
  ]);
  const directory = gitDirectory.trim();
  const attributes = join(directory, "blame-diff-attributes");
  const index = join(directory, "blame-diff-index");
  await writeFile(attributes, `${workingDiffAttributes}\n`);
  await copyFile(join(directory, "index"), index).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await rm(index, { force: true });
  });
  const git = (args: string[]) =>
    runGit(root, ["-c", `core.attributesFile=${attributes}`, ...args], {
      GIT_INDEX_FILE: index,
    });
  await git(["add", "--intent-to-add", "--", ...workingDiffAddPathspecs]);
  return (
    await git(["diff", "--no-ext-diff", from, "--", ...workingDiffPathspecs])
  ).stdout;
}

export async function gitDiffBetween(input: GitDiffInput) {
  const from = revision(input.from);
  const to = revision(input.to);
  const excludedEnvFiles = await committedRuntimeEnvPathspecs(
    input.root,
    from,
    to,
  );
  const { stdout } = await runGit(input.root, [
    "diff",
    "--no-ext-diff",
    from,
    to,
    "--",
    ".",
    ...excludedEnvFiles,
    ...ignoredGitDiffPathspecs,
  ]);
  return stdout;
}

export async function gitDiffStatsBetween(input: GitDiffInput) {
  const from = revision(input.from);
  const to = revision(input.to);
  const excludedEnvFiles = await committedRuntimeEnvPathspecs(
    input.root,
    from,
    to,
  );
  const { stdout } = await runGit(input.root, [
    "diff",
    "--numstat",
    "--no-ext-diff",
    from,
    to,
    "--",
    ".",
    ...excludedEnvFiles,
    ...ignoredGitDiffPathspecs,
  ]);
  return workspaceDiffStats(stdout);
}

export async function listGitDirectory(input: GitDirectoryInput) {
  const path = gitPath(input.path);
  const entries = new Map<string, GitTreeEntry>();
  const trees = await Promise.all(
    input.refs.map((ref) =>
      gitReadLimit(() => readGitTree(input.root, ref, path)),
    ),
  );
  for (const stdout of trees) {
    parseTree(stdout, path).forEach((entry) => entries.set(entry.name, entry));
  }
  return [...entries.values()].sort((left, right) =>
    `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`),
  );
}

export async function readGitFile(input: GitFileInput) {
  const path = gitPath(input.path);
  let lastError: unknown;
  for (const ref of input.refs) {
    try {
      const { stdout } = await runGit(input.root, [
        "show",
        `${revision(ref)}:${path}`,
      ]);
      return stdout;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function ensureGitRepository(
  root: string,
  execution?: WorkspaceExecution,
) {
  const git = repositoryGitRunner(execution);
  const cwd = resolveWorkspacePath(root);
  let changed = false;

  if (!(await isGitRepository(cwd, execution))) {
    await git(cwd, ["init"]);
    changed = true;
  }

  if (!(await hasGitHead(cwd, git))) {
    await createInitialGitCommit(cwd, git);
    changed = true;
  }

  return changed;
}

export async function isGitRepository(
  root: string,
  execution?: WorkspaceExecution,
) {
  const git = repositoryGitRunner(execution);
  const cwd = resolveWorkspacePath(root);
  try {
    // The host path (C:\\...) and Git's WSL path (/mnt/c/...) cannot be
    // compared directly. Git's prefix is empty only at the repository root,
    // including when that root was reached through a symlink.
    if (execution === "virtualized") {
      const { stdout } = await git(cwd, ["rev-parse", "--show-prefix"]);
      return stdout.trim() === "";
    }
    const { stdout } = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const [gitRoot, workspaceRoot] = await Promise.all([
      canonicalWorkspacePath(stdout.trim()),
      canonicalWorkspacePath(cwd),
    ]);
    return gitRoot === workspaceRoot;
  } catch {
    return false;
  }
}

function repositoryGitRunner(execution?: WorkspaceExecution): GitRunner {
  return execution
    ? (cwd, args) => runRuntimeGit(cwd, args, execution)
    : runGit;
}

async function canonicalWorkspacePath(path: string) {
  const resolved = resolve(path);
  if (runtimeManagedPath(resolved)) return resolved;
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

type GitTreeEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

function parseTree(output: string, parent: string) {
  return output
    .split("\0")
    .filter(Boolean)
    .map((line) => treeEntry(line, parent));
}

function treeEntry(line: string, parent: string): GitTreeEntry {
  const [metadata, name] = line.split("\t", 2);
  const type = metadata.split(" ")[1] === "tree" ? "directory" : "file";
  return {
    name: basename(name),
    path: parent ? `${parent}/${name}` : name,
    type,
  };
}

function revision(value: string) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:\^)?$/i.test(value)) {
    throw new Error("Invalid Git revision");
  }
  return value;
}

export function runtimeEnvPath(path: string) {
  const name = basename(path);
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return ![".example", ".sample", ".template"].some((suffix) =>
    name.endsWith(suffix),
  );
}

export function excludedGitPathspec(path: string) {
  return `:!${gitPath(path)}`;
}

async function committedRuntimeEnvPathspecs(
  root: string,
  from: string,
  to: string,
) {
  const { stdout } = await runGit(root, [
    "diff",
    "--name-only",
    from,
    to,
    "--",
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .filter(runtimeEnvPath)
    .map(excludedGitPathspec);
}

async function changedRuntimeEnvPathspecs(
  root: string,
  gitRunner: GitRunner = runGit,
) {
  const [{ stdout: worktree }, { stdout: staged }] = await Promise.all([
    gitRunner(root, [
      "ls-files",
      "--modified",
      "--deleted",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
    gitRunner(root, ["diff", "--cached", "--name-only", "-z", "--"]),
  ]);
  return [...new Set(`${worktree}${staged}`.split("\0"))]
    .filter(Boolean)
    .filter(runtimeEnvPath)
    .map(excludedGitPathspec);
}

async function trackedRuntimeEnvPaths(
  root: string,
  environment: Record<string, string>,
  gitRunner: GitRunner = runGit,
) {
  const { stdout } = await gitRunner(root, ["ls-files", "-z"], environment);
  return stdout.split("\0").filter(Boolean).filter(runtimeEnvPath);
}

function gitPath(value?: string) {
  const normalized = posix.normalize((value ?? "").replaceAll("\\", "/"));
  if (!normalized || normalized === ".") return "";
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new Error("Path escapes workspace");
  }
  return normalized.replace(/\/$/, "");
}

// Story worktrees of a local container can live inside BlameRuntime, out of
// reach of the host's git: run Git there for them.
async function runGit(
  root: string,
  args: string[],
  environment?: Record<string, string>,
) {
  if (runtimeManagedPath(root))
    return runVirtualizedGit(root, args, environment);
  const env = { ...process.env, ...environment };
  return execFileAsync(hostGitCommand({ env }), args, {
    cwd: root,
    env,
    maxBuffer,
  });
}

async function runVirtualizedGit(
  root: string,
  args: string[],
  environment?: Record<string, string>,
) {
  if (!environment) return runRuntimeGit(root, args);
  // Host variables do not reach the runtime: set them on the command.
  const variables = Object.entries(environment).map(
    ([name, value]) => `${name}=${value}`,
  );
  return runRuntime("env", [...variables, "git", ...args], {
    cwd: root,
    execution: "virtualized",
    maxBuffer,
  });
}

function runBackgroundGit(
  root: string,
  args: string[],
  environment?: Record<string, string>,
) {
  if (runtimeManagedPath(root))
    return runVirtualizedGit(root, args, environment);
  const env = { ...process.env, ...environment };
  let command: string;
  try {
    command = hostGitCommand({ env });
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: root,
        encoding: "utf8",
        env,
        maxBuffer,
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stderr, stdout });
      },
    );
    deprioritizeProcess(child.pid);
  });
}

function deprioritizeProcess(pid: number | undefined) {
  if (!pid) return;
  try {
    setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}
  if (process.platform !== "linux") return;
  const ionice = execFile(
    "ionice",
    ["-c", "3", "-p", String(pid)],
    () => undefined,
  );
  ionice.unref();
}

async function hasGitHead(cwd: string, git: GitRunner) {
  try {
    await git(cwd, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function createInitialGitCommit(cwd: string, git: GitRunner) {
  await git(cwd, ["add", "-A", "--", "."]);
  await git(cwd, [
    "-c",
    "user.name=Blame",
    "-c",
    "user.email=blame@local",
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "--no-verify",
    "-m",
    "chore: initialize repository",
  ]);
}

async function readGitTree(root: string, ref: string, path: string) {
  const tree = path ? `${revision(ref)}:${path}` : `${revision(ref)}:`;
  try {
    return (await runGit(root, ["ls-tree", "-z", tree])).stdout;
  } catch (error) {
    if (!path) throw error;
    return "";
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
