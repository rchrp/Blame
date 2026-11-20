import { basename } from "node:path";

import { git } from "./runtime-git.js";

// Git on a story worktree: Blame's runtime artifacts and the project's
// runtime .env files never reach a commit, a status or an agent prompt.
const runtimeArtifactPaths = [".blame", ".blame-preview", ".pnpm-store"];
const runtimeArtifactPathspecs = runtimeArtifactPaths.map(
  (path) => `:!${path}`,
);

export async function storyChangedFiles(cwd: string, paths = ["."]) {
  return git(cwd, [
    "diff",
    "--no-ext-diff",
    "--name-status",
    "HEAD",
    "--",
    ...paths,
    ...runtimeArtifactPathspecs,
  ]);
}

export async function storyDiffStat(cwd: string, paths = ["."]) {
  return git(cwd, [
    "diff",
    "--no-ext-diff",
    "--stat",
    "HEAD",
    "--",
    ...paths,
    ...runtimeArtifactPathspecs,
  ]);
}

export async function storyStatus(
  cwd: string,
  format: "--porcelain" | "--short",
  paths = ["."],
) {
  const envPathspecs = (await changedRuntimeEnvPaths(cwd)).map(
    (path) => `:!${path}`,
  );
  return git(cwd, [
    "status",
    format,
    "--",
    ...paths,
    ...runtimeArtifactPathspecs,
    ...envPathspecs,
  ]);
}

export async function addStoryChanges(cwd: string) {
  const envPaths = await changedRuntimeEnvPaths(cwd);
  await git(cwd, ["add", "-A", "--", "."]);
  await git(cwd, [
    "reset",
    "--quiet",
    "--",
    ...runtimeArtifactPaths,
    ...envPaths,
  ]);
}

export async function removeRuntimeEnvChanges(cwd: string, baseCommit: string) {
  const changedFiles = await git(cwd, [
    "diff",
    "--name-only",
    `${baseCommit}...HEAD`,
  ]);
  const envPaths = splitLines(changedFiles).filter(runtimeEnvPath);
  if (!envPaths.length) return;
  for (const path of envPaths) {
    if (await gitPathExists(cwd, baseCommit, path)) {
      await git(cwd, [
        "restore",
        "--source",
        baseCommit,
        "--staged",
        "--worktree",
        "--",
        path,
      ]);
    } else {
      await git(cwd, ["rm", "--cached", "--ignore-unmatch", "--", path]);
    }
  }
  await git(cwd, ["commit", "-m", "chore: exclude runtime environment files"]);
}

async function changedRuntimeEnvPaths(cwd: string) {
  const paths = await git(cwd, [
    "ls-files",
    "--modified",
    "--deleted",
    "--others",
    "--exclude-standard",
  ]);
  return splitLines(paths).filter(runtimeEnvPath);
}

async function gitPathExists(cwd: string, revision: string, path: string) {
  try {
    await git(cwd, ["cat-file", "-e", `${revision}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

function runtimeEnvPath(path: string) {
  const name = basename(path);
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return ![".example", ".sample", ".template"].some((suffix) =>
    name.endsWith(suffix),
  );
}

export function isRuntimeArtifactPath(path: string) {
  return (
    runtimeEnvPath(path) ||
    runtimeArtifactPaths.some(
      (artifact) => path === artifact || path.startsWith(`${artifact}/`),
    )
  );
}

function splitLines(value: string) {
  return value.split("\n").filter(Boolean);
}

export function truncateText(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated]`;
}
