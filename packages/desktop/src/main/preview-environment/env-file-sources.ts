import { posix, win32 } from "node:path";
import {
  projectEnvFiles,
  relativeWorkspacePath,
  syncProjectEnvFiles,
  writeWorkspaceEnvFile,
} from "../workspace-env.ts";
import {
  joinWorkspacePath,
  readExistingFiles,
  readFile,
  run,
} from "../workspace-runtime.ts";
import type { EnvFileInput } from "./environment-resolver.ts";

// A story's env files, read live from the project at each preview start. The
// files git ignores, such as `.env`, belong to the developer's checkout: the
// story gets their current content, so editing `.env` reaches every story at
// its next start. The files git tracks belong to the story's branch, which
// may change them like any other code.

const sourceFile = [".blame", "environment", "source.json"];

/** Remembers which project a story worktree comes from. */
export async function recordWorktreeSource(
  worktree: string,
  repositoryRoot: string,
) {
  await writeWorkspaceEnvFile(
    joinWorkspacePath(worktree, ...sourceFile),
    `${JSON.stringify({ repositoryRoot })}\n`,
  );
}

/** A new story worktree: where it comes from, and the project's env files. */
export async function prepareStoryEnvFiles(
  repositoryRoot: string,
  worktree: string,
) {
  await recordWorktreeSource(worktree, repositoryRoot);
  return syncProjectEnvFiles(repositoryRoot, worktree, undefined, (paths) =>
    inProjectDirectories(repositoryRoot, paths),
  );
}

// Env files in directories git tracks: not in a build output or a scratch
// folder that happens to hold one.
async function inProjectDirectories(repositoryRoot: string, paths: string[]) {
  const relative = paths.map((path) =>
    relativeWorkspacePath(repositoryRoot, path),
  );
  const directories = await trackedDirectories(
    repositoryRoot,
    relative.map((path) => posix.dirname(path)),
  );
  return paths.filter((_, index) =>
    directories.has(posix.dirname(relative[index]!)),
  );
}

const roots = new Map<string, Promise<string>>();

/** The project checkout a worktree comes from; itself in Direct mode. */
export function worktreeRepositoryRoot(worktree: string) {
  const cached = roots.get(worktree);
  if (cached) return cached;
  const next = findRepositoryRoot(worktree).catch((error) => {
    roots.delete(worktree);
    throw error;
  });
  roots.set(worktree, next);
  return next;
}

async function findRepositoryRoot(worktree: string) {
  const recorded = await readFile(joinWorkspacePath(worktree, ...sourceFile))
    .then(
      (text) =>
        (JSON.parse(text) as { repositoryRoot?: unknown }).repositoryRoot,
    )
    .catch(() => undefined);
  if (typeof recorded === "string" && recorded) return recorded;
  const { stdout } = await run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: worktree },
  );
  return hostPath(posix.dirname(stdout.trim()));
}

// WSL sees a Windows folder under /mnt/<drive>.
function hostPath(path: string, platform = process.platform) {
  const drive = /^\/mnt\/([a-z])(\/.*)?$/i.exec(path);
  if (platform !== "win32" || !drive) return path;
  return win32.join(
    `${drive[1]!.toUpperCase()}:\\`,
    ...(drive[2] ?? "").split("/"),
  );
}

export type StoryEnvFiles = {
  repositoryRoot: string;
  files: EnvFileInput[];
  /**
   * Env files whose content came from the project because the story's copy
   * differed: written into the story at a start, only read otherwise.
   */
  fromProject: string[];
};

/**
 * The story's env files and examples, its ignored ones as the project has
 * them now. A start writes those into the worktree (`write`); reading for the
 * Variables tab does not.
 */
export async function liveStoryEnvFiles(
  worktree: string,
  options: { write?: boolean } = {},
): Promise<StoryEnvFiles> {
  const repositoryRoot = await worktreeRepositoryRoot(worktree).catch(
    () => worktree,
  );
  const fresh =
    repositoryRoot === worktree
      ? new Map<string, string>()
      : await changedIgnoredEnvFiles(repositoryRoot, worktree);
  if (options.write)
    for (const [relative, content] of fresh)
      await writeWorkspaceEnvFile(
        joinWorkspacePath(worktree, relative),
        content,
      );
  const listed = await projectEnvFiles(worktree);
  const paths = [...listed.runtime, ...listed.templates];
  const contents = await readExistingFiles(paths);
  const files = new Map<string, string>();
  for (const path of paths) {
    const content = contents[path];
    if (typeof content === "string")
      files.set(relativeWorkspacePath(worktree, path), content);
  }
  for (const [relative, content] of fresh) files.set(relative, content);
  return {
    repositoryRoot,
    files: [...files].map(([path, content]) => ({ path, content })),
    fromProject: [...fresh.keys()],
  };
}

// The project's ignored env files whose story copy differs or is missing.
async function changedIgnoredEnvFiles(
  repositoryRoot: string,
  worktree: string,
) {
  const changed = new Map<string, string>();
  const checkout = (await projectEnvFiles(repositoryRoot)).runtime.map(
    (path) => ({ path, relative: relativeWorkspacePath(repositoryRoot, path) }),
  );
  if (!checkout.length) return changed;
  const tracked = await trackedPaths(
    repositoryRoot,
    checkout.map(({ relative }) => relative),
  );
  // Without git, a tracked file cannot be told apart: leave them all.
  if (!tracked) return changed;
  // Only directories of the project itself: not a build output or a nested
  // worktree that happens to hold an env file.
  const directories = await trackedDirectories(
    repositoryRoot,
    checkout.map(({ relative }) => posix.dirname(relative)),
  );
  const ignored = checkout.filter(
    ({ relative }) =>
      !tracked.has(relative) && directories.has(posix.dirname(relative)),
  );
  const [sources, copies] = await Promise.all([
    readExistingFiles(ignored.map(({ path }) => path)),
    readExistingFiles(
      ignored.map(({ relative }) => joinWorkspacePath(worktree, relative)),
    ),
  ]);
  for (const { path, relative } of ignored) {
    const source = sources[path];
    const copy = copies[joinWorkspacePath(worktree, relative)];
    if (typeof source === "string" && copy !== source)
      changed.set(relative, source);
  }
  return changed;
}

async function trackedDirectories(repositoryRoot: string, paths: string[]) {
  const directories = new Set(["."]);
  const nested = [...new Set(paths.filter((path) => path !== "."))];
  if (!nested.length) return directories;
  try {
    const { stdout } = await run(
      "git",
      ["ls-tree", "-r", "-d", "-z", "--name-only", "HEAD", "--", ...nested],
      { cwd: repositoryRoot },
    );
    for (const path of stdout.split("\0")) if (path) directories.add(path);
  } catch {}
  return directories;
}

async function trackedPaths(repositoryRoot: string, paths: string[]) {
  try {
    const { stdout } = await run(
      "git",
      ["ls-files", "--full-name", "-z", "--", ...paths],
      { cwd: repositoryRoot },
    );
    return new Set(stdout.split("\0").filter(Boolean));
  } catch {
    return undefined;
  }
}
