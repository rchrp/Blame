import { randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
  run as runInWorkspace,
  runtimeManagedPath,
} from "../workspace-runtime.ts";

// Files the agent hands to a page's file input. They must come from its
// workspace, or from the scope's private artifacts. A workspace the host
// cannot read directly (inside the runtime VM) is copied out first, up to
// 20 MiB a file.

export type UploadScope = {
  // The scope's private directory on the host.
  artifacts: string;
  signal?: AbortSignal;
  // The workspace as the host sees it, when it can read it.
  workspace?: string;
  worktree: string;
};

const maximumStagedUploadBytes = 20 * 1024 * 1024;

export async function uploadFilePaths(scope: UploadScope, values: unknown[]) {
  const paths: string[] = [];
  for (const value of values) {
    const candidate = requiredUploadPath(value);
    const artifact = isAbsolute(candidate)
      ? await resolvedContainedPath(scope.artifacts, candidate)
      : undefined;
    if (artifact) paths.push(artifact);
    else if (scope.workspace)
      paths.push(await accessibleUploadPath(scope, scope.workspace, candidate));
    else paths.push(await stageRuntimeUpload(scope, candidate));
  }
  return paths;
}

async function accessibleUploadPath(
  scope: UploadScope,
  workspace: string,
  candidate: string,
) {
  const contained = await resolvedContainedPath(workspace, candidate);
  if (contained) return contained;
  if (!runtimeManagedPath(scope.worktree)) throw uploadOutsideWorkspaceError();
  const relativePath = workspaceUploadRelativePath(scope.worktree, candidate);
  const bridgedPath = join(workspace, ...relativePath.split("/"));
  const bridged = await resolvedContainedPath(workspace, bridgedPath);
  if (!bridged) throw uploadOutsideWorkspaceError();
  return bridged;
}

async function stageRuntimeUpload(scope: UploadScope, candidate: string) {
  if (!runtimeManagedPath(scope.worktree)) {
    throw new Error("The preview workspace is not accessible from the host.");
  }
  scope.signal?.throwIfAborted();
  const source = await runtimeUploadSource(scope.worktree, candidate);
  await assertStagedUploadSize(source, scope.worktree);
  const { stdout } = await runInWorkspace(
    "base64",
    ["--wrap=0", "--", source],
    { cwd: scope.worktree, maxBuffer: maximumStagedUploadBytes * 2 },
  );
  scope.signal?.throwIfAborted();
  const destination = join(scope.artifacts, stagedUploadName(source));
  await writeFile(destination, Buffer.from(stdout.trim(), "base64"));
  return destination;
}

async function runtimeUploadSource(worktree: string, candidate: string) {
  const relativePath = workspaceUploadRelativePath(worktree, candidate);
  const source = posix.join(posix.resolve(worktree), relativePath);
  const { stdout } = await runInWorkspace("realpath", ["--", source], {
    cwd: worktree,
  });
  const canonical = stdout.trim();
  workspaceUploadRelativePath(worktree, canonical);
  return canonical;
}

async function assertStagedUploadSize(source: string, worktree: string) {
  const { stdout } = await runInWorkspace("stat", ["-c", "%s", "--", source], {
    cwd: worktree,
  });
  const size = Number(stdout.trim());
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Unable to determine the preview upload size.");
  }
  if (size > maximumStagedUploadBytes) {
    throw new Error("Preview uploads from the runtime are limited to 20 MiB.");
  }
}

export function workspaceUploadRelativePath(
  worktree: string,
  candidate: string,
) {
  const root = posix.resolve(worktree.replaceAll("\\", "/"));
  const normalized = candidate.replaceAll("\\", "/");
  const file = posix.isAbsolute(normalized)
    ? posix.normalize(normalized)
    : posix.resolve(root, normalized);
  const relativePath = posix.relative(root, file);
  if (!relativePath || escapesRoot(relativePath, posix.sep)) {
    throw uploadOutsideWorkspaceError();
  }
  return relativePath;
}

function stagedUploadName(source: string) {
  const name = posix.basename(source).replace(/[^a-zA-Z0-9._-]/gu, "_");
  return `${randomUUID()}-${name.slice(0, 120) || "upload"}`;
}

function requiredUploadPath(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 8_192) {
    throw new Error("Preview upload path is invalid.");
  }
  return value.trim();
}

async function resolvedContainedPath(root: string, candidate: string) {
  const contained = containedPath(root, candidate);
  if (!contained) return undefined;
  const canonical = await realpath(contained);
  return containedPath(root, canonical);
}

function containedPath(root: string, candidate: string) {
  const file = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(root, candidate);
  const relativePath = relative(root, file);
  return !relativePath || escapesRoot(relativePath, sep) ? undefined : file;
}

function escapesRoot(relativePath: string, separator: string) {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${separator}`) ||
    isAbsolute(relativePath)
  );
}

function uploadOutsideWorkspaceError() {
  return new Error("Preview uploads must stay inside the workspace.");
}
