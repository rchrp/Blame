import { createHash } from "node:crypto";

import { posix } from "node:path";

import {
  excludedGitPathspec,
  gitDiffStatsBetween,
  gitLogArguments,
  runtimeEnvPath,
} from "../workspace-git";

import { workspaceDiffStats } from "../workspace-diff-stats";

import {
  ignoredGitDiffPathspecs,
  isIgnoredWorkspaceDiffPath,
} from "../workspace-diff-policy";

import {
  joinWorkspacePath,
  readFile as readRuntimeFile,
  resolveWorkspacePath as resolveRuntimePath,
  rm as rmRuntime,
  runtimeManagedPath,
  writeFile as writeRuntimeFile,
} from "../workspace-runtime";

import {
  ensureRuntimeGitSafeDirectory,
  runRuntimeGit,
} from "../workspace-runtime-git.ts";

import { gitCommitFiles } from "./workspace-git-commit.ts";

export type GitLogInput = {
  currentBranchOnly?: boolean;
  limit?: number;
  root: string;
  skip?: number;
};

export type GitPathInput = {
  path: string;
  root: string;
  staged?: boolean;
};

export type GitConflictFileInput = {
  path: string;
  root: string;
};

export type GitAcceptConflictFileInput = GitConflictFileInput & {
  side: "current" | "incoming";
};

export type GitResolveConflictFileInput = GitConflictFileInput & {
  content?: string;
};

export type GitCommitDiffInput = {
  hash: string;
  root: string;
};

export type GitFilesInput = {
  paths: string[];
  root: string;
};

export type GitCommitInput = {
  message: string;
  // Commit only these files, leaving the rest of the index as it is.
  paths?: string[];
  root: string;
};

export async function gitDiff(root: string) {
  const cwd = resolveRuntimePath(root);
  const excludedEnvFiles = await changedRuntimeEnvPathspecs(cwd);
  const { stdout } = await runRuntimeGit(cwd, [
    "diff",
    "--no-ext-diff",
    "--",
    ".",
    ...excludedEnvFiles,
    ...ignoredGitDiffPathspecs,
  ]);
  return stdout;
}

export async function gitDiffStats(input: {
  from?: string;
  root: string;
  to?: string;
}) {
  if (input.from && input.to) {
    return gitDiffStatsBetween({
      from: input.from,
      root: input.root,
      to: input.to,
    });
  }
  const cwd = resolveRuntimePath(input.root);
  const excludedEnvFiles = await changedRuntimeEnvPathspecs(cwd);
  const { stdout } = await runRuntimeGit(cwd, [
    "diff",
    "--numstat",
    "--no-ext-diff",
    "--",
    ".",
    ...excludedEnvFiles,
    ...ignoredGitDiffPathspecs,
  ]);
  return workspaceDiffStats(stdout);
}

async function changedRuntimeEnvPathspecs(cwd: string) {
  const { stdout } = await runRuntimeGit(cwd, [
    "ls-files",
    "--modified",
    "--deleted",
    "--others",
    "--exclude-standard",
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .filter(runtimeEnvPath)
    .map(excludedGitPathspec);
}

export async function gitStatus(root: string) {
  const cwd = resolveRuntimePath(root);
  const [branch, remotes] = await Promise.all([
    gitBranchStatus(cwd),
    gitRemoteUrls(cwd),
  ]);
  const { stdout } = await runRuntimeGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return { branch, files: parseGitStatusFiles(stdout), remote: remotes[0] };
}

export async function gitLog(input: GitLogInput) {
  const cwd = resolveRuntimePath(input.root);
  try {
    const { stdout } = await runRuntimeGit(cwd, gitLogArguments(input));
    return parseGitLog(stdout);
  } catch {
    return [];
  }
}

export async function gitCommitCount(root: string) {
  const cwd = resolveRuntimePath(root);
  try {
    const { stdout } = await runRuntimeGit(cwd, [
      "rev-list",
      "--all",
      "--count",
    ]);
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

export async function gitFileDiff(input: GitPathInput) {
  const cwd = resolveRuntimePath(input.root);
  const path = gitWorkspacePath(input.path);
  if (isIgnoredWorkspaceDiffPath(path)) return "";
  const args = input.staged
    ? [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--",
        path,
        ...ignoredGitDiffPathspecs,
      ]
    : ["diff", "--no-ext-diff", "--", path, ...ignoredGitDiffPathspecs];
  const { stdout } = await runRuntimeGit(cwd, args);
  if (stdout || input.staged || !(await gitPathIsUntracked(cwd, path)))
    return stdout;
  return untrackedGitDiff(cwd, path);
}

export async function gitCommitDiff(input: GitCommitDiffInput) {
  const cwd = resolveRuntimePath(input.root);
  const hash = gitHash(input.hash);
  try {
    const { stdout } = await runRuntimeGit(cwd, [
      "diff",
      "--no-ext-diff",
      `${hash}^`,
      hash,
      "--",
      ...ignoredGitDiffPathspecs,
    ]);
    return stdout;
  } catch {
    const { stdout } = await runRuntimeGit(cwd, [
      "show",
      "--format=",
      "--no-ext-diff",
      hash,
      "--",
      ...ignoredGitDiffPathspecs,
    ]);
    return stdout;
  }
}

export async function gitConflictFile(input: GitConflictFileInput) {
  const cwd = resolveRuntimePath(input.root);
  const path = gitWorkspacePath(input.path);
  return {
    base: await gitConflictStage(cwd, path, 1),
    current: await gitConflictStage(cwd, path, 2),
    incoming: await gitConflictStage(cwd, path, 3),
    path,
    result: await gitConflictResult(cwd, path),
  };
}

export async function gitAcceptConflictFile(input: GitAcceptConflictFileInput) {
  const cwd = resolveRuntimePath(input.root);
  const path = gitWorkspacePath(input.path);
  await runRuntimeGit(cwd, [
    "checkout",
    input.side === "current" ? "--ours" : "--theirs",
    "--",
    path,
  ]);
  await runRuntimeGit(cwd, ["add", "--", path]);
  return true;
}

export async function gitResolveConflictFile(
  input: GitResolveConflictFileInput,
) {
  const cwd = resolveRuntimePath(input.root);
  const path = gitWorkspacePath(input.path);
  if (input.content !== undefined) {
    await writeRuntimeFile(joinWorkspacePath(cwd, path), input.content);
  }
  await runRuntimeGit(cwd, ["add", "--", path]);
  return true;
}

export async function gitAbortConflict(root: string) {
  const cwd = resolveRuntimePath(root);
  return gitConflictCommand(cwd, [
    ["merge", "--abort"],
    ["rebase", "--abort"],
    ["cherry-pick", "--abort"],
    ["revert", "--abort"],
  ]);
}

export async function gitContinueConflict(root: string) {
  const cwd = resolveRuntimePath(root);
  return gitConflictCommand(cwd, [
    ["-c", "core.editor=true", "merge", "--continue"],
    ["-c", "core.editor=true", "rebase", "--continue"],
    ["-c", "core.editor=true", "cherry-pick", "--continue"],
    ["-c", "core.editor=true", "revert", "--continue"],
  ]);
}

export async function gitStageFiles(input: GitFilesInput) {
  const cwd = resolveRuntimePath(input.root);
  const paths = gitWorkspacePaths(input.paths);
  if (paths.length === 0) return false;
  await runRuntimeGit(cwd, ["add", "--", ...paths]);
  return true;
}

async function gitConflictStage(cwd: string, path: string, stage: number) {
  try {
    const { stdout } = await runRuntimeGit(cwd, ["show", `:${stage}:${path}`]);
    return stdout;
  } catch {
    return "";
  }
}

async function gitConflictResult(cwd: string, path: string) {
  try {
    return await readRuntimeFile(joinWorkspacePath(cwd, path));
  } catch {
    return "";
  }
}

async function gitConflictCommand(cwd: string, commands: string[][]) {
  let lastError: unknown;
  for (const command of commands) {
    try {
      const result = await runRuntimeGit(cwd, command);
      return { output: result.stdout || result.stderr };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("Unable to complete Git conflict command");
}

export async function gitUnstageFiles(input: GitFilesInput) {
  const cwd = resolveRuntimePath(input.root);
  const paths = gitWorkspacePaths(input.paths);
  if (paths.length === 0) return false;
  await runRuntimeGit(cwd, ["restore", "--staged", "--", ...paths]);
  return true;
}

export async function gitRollbackFiles(input: GitFilesInput) {
  const cwd = resolveRuntimePath(input.root);
  const paths = gitWorkspacePaths(input.paths);
  if (paths.length === 0) return false;
  await runRuntimeGit(cwd, [
    "restore",
    "--staged",
    "--worktree",
    "--",
    ...paths,
  ]);
  return true;
}

export async function gitDeleteFiles(input: GitFilesInput) {
  const cwd = resolveRuntimePath(input.root);
  const paths = gitWorkspacePaths(input.paths);
  if (paths.length === 0) return false;
  await Promise.all(
    paths.map((path) => rmRuntime(joinWorkspacePath(cwd, path))),
  );
  return true;
}

export async function gitCommit(input: GitCommitInput) {
  const cwd = resolveRuntimePath(input.root);
  const message = input.message.trim();
  if (!message) throw new Error("Commit message is required");
  if (input.paths) {
    const paths = gitWorkspacePaths(input.paths);
    if (paths.length === 0) throw new Error("Select files before committing");
    return gitCommitFiles(cwd, message, paths);
  }
  const result = await runRuntimeGit(cwd, [
    "commit",
    "--no-gpg-sign",
    "-m",
    message,
  ]);
  return { output: result.stdout || result.stderr };
}

// What the person staged for other files stays staged: `--only` commits the
// working-tree content of the given files and leaves the index of the rest.




export async function gitPush(root: string) {
  const cwd = resolveRuntimePath(root);
  const result = await runRuntimeGit(cwd, ["push"]);
  return { output: result.stdout || result.stderr };
}

async function gitBranchStatus(cwd: string) {
  const { stdout } = await runRuntimeGit(cwd, [
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=no",
  ]);
  return parseGitBranchStatus(stdout);
}

function parseGitBranchStatus(output: string) {
  const branch = { ahead: 0, behind: 0, current: "HEAD", detached: true };
  let oid = "";
  let head = "";
  let upstream: string | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.oid ")) oid = line.slice(13).trim();
    if (line.startsWith("# branch.head ")) head = line.slice(14).trim();
    if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim();
    if (line.startsWith("# branch.ab "))
      parseGitBranchAheadBehind(line, branch);
  }
  return {
    ...branch,
    current: head && head !== "(detached)" ? head : oid.slice(0, 7) || "HEAD",
    detached: !head || head === "(detached)",
    upstream,
  };
}

function parseGitBranchAheadBehind(
  line: string,
  branch: { ahead: number; behind: number },
) {
  const match = line.match(/\+(\d+)\s+-(\d+)/);
  if (!match) return;
  branch.ahead = Number(match[1]);
  branch.behind = Number(match[2]);
}

function parseGitStatusFiles(output: string) {
  const records = output.split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const originalPath = renamedGitStatus(indexStatus)
      ? records[index + 1]
      : undefined;
    if (originalPath) index += 1;
    files.push(
      gitStatusFile(record.slice(3), originalPath, indexStatus, worktreeStatus),
    );
  }
  return files.filter((file) => !isIgnoredWorkspaceDiffPath(file.path));
}

function gitStatusFile(
  path: string,
  originalPath: string | undefined,
  indexStatus: string,
  worktreeStatus: string,
) {
  return {
    conflicted: gitStatusConflicted(indexStatus, worktreeStatus),
    indexStatus,
    originalPath,
    path,
    staged: gitStatusStaged(indexStatus),
    status: gitFileStatus(indexStatus, worktreeStatus),
    untracked: indexStatus === "?" && worktreeStatus === "?",
    unstaged: gitStatusUnstaged(indexStatus, worktreeStatus),
    worktreeStatus,
  };
}

function renamedGitStatus(status: string) {
  return status === "R" || status === "C";
}

function gitStatusStaged(status: string) {
  return status !== " " && status !== "?" && status !== "!";
}

function gitStatusUnstaged(indexStatus: string, worktreeStatus: string) {
  if (indexStatus === "?" && worktreeStatus === "?") return true;
  return worktreeStatus !== " " && worktreeStatus !== "!";
}

function gitFileStatus(indexStatus: string, worktreeStatus: string) {
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  if (gitStatusConflicted(indexStatus, worktreeStatus)) return "conflict";
  const status = indexStatus !== " " ? indexStatus : worktreeStatus;
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  if (status === "R") return "renamed";
  if (status === "C") return "copied";
  return "modified";
}

function gitStatusConflicted(indexStatus: string, worktreeStatus: string) {
  return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(
    `${indexStatus}${worktreeStatus}`,
  );
}

function parseGitLog(output: string) {
  return output
    .split("\x1e")
    .map(parseGitLogRecord)
    .filter((commit) => commit !== undefined);
}

function parseGitLogRecord(record: string) {
  const parts = record.replace(/^\n+|\n+$/g, "").split("\x1f");
  if (parts.length < 7 || !parts[0]) return undefined;
  return {
    authorEmail: parts[3],
    authorName: parts[2],
    date: parts[4],
    hash: parts[0],
    message: parts.slice(6).join("\x1f"),
    parents: parts[1].split(" ").filter(Boolean),
    refs: parseGitRefs(parts[5]),
  };
}

function parseGitRefs(value: string) {
  return value
    .split(",")
    .map((ref) => ref.trim())
    .filter(Boolean)
    .map((ref) => ({ name: gitRefName(ref), type: gitRefType(ref) }));
}

function gitRefName(ref: string) {
  if (ref.startsWith("HEAD -> ")) return ref.slice(8);
  if (ref.startsWith("tag: ")) return ref.slice(5);
  return ref;
}

function gitRefType(ref: string) {
  if (ref === "HEAD" || ref.startsWith("HEAD -> ")) return "head";
  if (ref.startsWith("tag: ")) return "tag";
  if (ref.includes("/")) return "remote";
  return "branch";
}

function gitWorkspacePaths(paths: string[]) {
  return [...new Set(paths.map(gitWorkspacePath))];
}

function gitWorkspacePath(value: string) {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.includes("\0")
  ) {
    throw new Error("Path escapes workspace");
  }
  return normalized;
}

function gitHash(value: string) {
  if (!/^[0-9a-f]{7,40}$/i.test(value)) throw new Error("Invalid Git hash");
  return value;
}

async function gitPathIsUntracked(cwd: string, path: string) {
  const { stdout } = await runRuntimeGit(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    path,
  ]);
  return stdout.split("\n").some((line) => line.trim() === path);
}

async function untrackedGitDiff(cwd: string, path: string) {
  try {
    const { stdout } = await runRuntimeGit(cwd, [
      "diff",
      "--no-ext-diff",
      "--no-index",
      "--",
      gitEmptyFilePath(cwd),
      path,
    ]);
    return stdout;
  } catch (error) {
    return commandText(error, "stdout");
  }
}

function gitEmptyFilePath(cwd: string) {
  if (process.platform === "win32" && !runtimeManagedPath(cwd)) return "NUL";
  return "/dev/null";
}

export async function gitRepositoryFingerprint(root: string) {
  const cwd = resolveRuntimePath(root);
  await ensureRuntimeGitSafeDirectory(cwd);
  const remoteUrls = await gitRemoteUrls(cwd);
  if (remoteUrls.length > 0) {
    return fingerprintValue(["remotes", ...remoteUrls]);
  }

  const rootCommits = await gitRootCommits(cwd);
  if (rootCommits.length > 0) {
    return fingerprintValue(["root-commits", ...rootCommits]);
  }

  return null;
}

async function gitRemoteUrls(cwd: string) {
  try {
    const { stdout } = await runRuntimeGit(cwd, [
      "config",
      "--get-regexp",
      "^remote\\..*\\.url$",
    ]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/, 2)[1])
      .filter(Boolean)
      .map(normalizeGitRemoteUrl)
      .sort();
  } catch {
    return [];
  }
}

export function commandText(error: unknown, key: "stdout" | "stderr") {
  if (!error || typeof error !== "object") return "";
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

async function gitRootCommits(cwd: string) {
  try {
    const { stdout } = await runRuntimeGit(cwd, [
      "rev-list",
      "--max-parents=0",
      "HEAD",
    ]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function normalizeGitRemoteUrl(value: string) {
  const trimmed = value.trim().replace(/\.git$/, "");
  const sshMatch = trimmed.match(/^([^@]+@[^:]+):(.+)$/);
  if (sshMatch) {
    return `ssh://${sshMatch[1]}/${sshMatch[2]}`.toLowerCase();
  }
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function fingerprintValue(parts: string[]) {
  return `git:${createHash("sha256").update(parts.join("\n")).digest("hex")}`;
}
