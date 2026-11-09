import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  canonicalRoot,
  fileName,
  isEnvironmentTemplatePath,
  takeBalancedGroups,
} from "./project-discovery.js";

const execFileAsync = promisify(execFile);

export type ProjectGitLog = {
  root: string;
  messages: string[];
};

export async function readBoundedProjectFiles(
  root: string,
  paths: string[],
  totalBytes: number,
  perFileBytes: number,
) {
  const evidence: Record<string, string> = {};
  const canonicalProjectRoot = await canonicalRoot(root);
  const readablePaths = paths.filter(isReadableEvidencePath);
  const fairFileBytes = Math.max(
    1,
    Math.floor(totalBytes / Math.max(1, readablePaths.length)),
  );
  const fileBytes = Math.min(perFileBytes, fairFileBytes);
  let remainingBytes = totalBytes;
  for (const path of readablePaths) {
    if (remainingBytes <= 0) break;
    const content = await readProjectFile(
      root,
      canonicalProjectRoot,
      path,
      Math.min(fileBytes, remainingBytes),
    );
    if (content === undefined) continue;
    evidence[path] = content;
    remainingBytes -= Buffer.byteLength(content);
  }
  return evidence;
}

function isReadableEvidencePath(path: string) {
  if (isEnvironmentTemplatePath(path)) return true;
  const name = fileName(path);
  return !(
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".envrc" ||
    name.startsWith(".envrc.") ||
    name.endsWith(".env")
  );
}

async function readProjectFile(
  root: string,
  canonicalProjectRoot: string,
  path: string,
  maxBytes: number,
) {
  const target = resolve(root, path);
  try {
    if (!isPathInside(resolve(root), target)) return undefined;
    if ((await lstat(target)).isSymbolicLink()) return undefined;
    const canonicalTarget = await realpath(target);
    if (!isPathInside(canonicalProjectRoot, canonicalTarget)) return undefined;
    const info = await stat(canonicalTarget);
    if (!info.isFile()) return undefined;
    return await readFilePrefix(canonicalTarget, info.size, maxBytes);
  } catch {
    return undefined;
  }
}

function isPathInside(root: string, target: string) {
  const path = relative(root, target);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function readFilePrefix(path: string, size: number, maxBytes: number) {
  const noFollow =
    typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const bytesToRead = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    if (buffer.subarray(0, bytesRead).includes(0)) return undefined;
    const suffix = size > bytesRead ? "\n[truncated]" : "";
    return buffer.subarray(0, bytesRead).toString("utf8") + suffix;
  } finally {
    await handle.close();
  }
}

export async function recentProjectGitLogs(
  root: string,
  repositoryRoots: string[],
  limit: number,
) {
  const roots = repositoryRoots.length ? repositoryRoots.slice(0, 12) : ["."];
  const logs = await Promise.all(
    roots.map(async (repositoryRoot) => ({
      root: repositoryRoot,
      messages: await gitMessages(join(root, repositoryRoot), limit),
    })),
  );
  return logs.filter(({ messages }) => messages.length);
}

export function balancedGitMessages(logs: ProjectGitLog[], limit: number) {
  const groups = logs.map(({ messages }) => [...messages]);
  return takeBalancedGroups(groups, limit);
}

async function gitMessages(root: string, limit: number) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", `-${limit}`, "--no-merges", "--pretty=%s"],
      {
        cwd: root,
        timeout: 3_000,
      },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
