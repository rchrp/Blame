import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

export type TargetChangesStash = {
  commit: string;
  deletedStagedAdditions: string[];
};

type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export async function stashTargetChanges(
  cwd: string,
  git: GitRunner,
): Promise<TargetChangesStash | undefined> {
  const [added, deleted] = await Promise.all([
    git(cwd, ["diff", "--cached", "--name-status", "--diff-filter=A", "-z"]),
    git(cwd, ["diff", "--name-status", "--diff-filter=D", "-z"]),
  ]);
  const deletedPaths = new Set(statusPaths(deleted));
  const deletedStagedAdditions = statusPaths(added).filter((path) =>
    deletedPaths.has(path),
  );
  const previous = await optionalGitRevision(cwd, "refs/stash", git);
  await git(cwd, [
    "stash",
    "push",
    "--include-untracked",
    "--message",
    `blame-approve-merge-${randomUUID()}`,
  ]);
  const commit = await optionalGitRevision(cwd, "refs/stash", git);
  return commit && commit !== previous
    ? { commit, deletedStagedAdditions }
    : undefined;
}

export async function assertTargetChangesRestorable(
  cwd: string,
  stash: TargetChangesStash | undefined,
  git: GitRunner,
) {
  if (!stash) return;
  try {
    await applyTargetChanges(cwd, stash, git);
  } catch (error) {
    throw new Error(
      `The story changes conflict with local target-branch changes. The merge was stopped before advancing the target branch. ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    await git(cwd, ["reset", "--hard", "HEAD"]);
    await git(cwd, ["clean", "-d", "-f"]);
  }
}

export async function restoreTargetChanges(
  cwd: string,
  stash: TargetChangesStash,
  git: GitRunner,
) {
  try {
    await applyTargetChanges(cwd, stash, git);
  } catch (error) {
    throw new Error(
      `Git could not restore the local target-branch changes automatically. They remain saved in the stash (${stash.commit}). ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const reference = await gitStashReference(cwd, stash.commit, git);
  if (!reference) return {};
  try {
    await git(cwd, ["stash", "drop", reference]);
    return {};
  } catch (cleanupError) {
    return { cleanupError };
  }
}

function statusPaths(output: string) {
  return output.split("\0").filter((_, index) => index % 2 === 1);
}

async function applyTargetChanges(
  cwd: string,
  stash: TargetChangesStash,
  git: GitRunner,
) {
  await git(cwd, ["stash", "apply", "--index", stash.commit]);
  // Git restores newly staged files even when they were deleted from the
  // working tree before stashing. Keep their index blobs, but restore absence.
  for (const path of stash.deletedStagedAdditions) {
    await unlink(join(cwd, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function optionalGitRevision(
  cwd: string,
  revision: string,
  git: GitRunner,
) {
  try {
    return await git(cwd, ["rev-parse", "--verify", revision]);
  } catch {
    return undefined;
  }
}

async function gitStashReference(cwd: string, commit: string, git: GitRunner) {
  const entries = await git(cwd, ["stash", "list", "--format=%gd%x00%H"]);
  for (const entry of entries.split("\n")) {
    const [reference, hash] = entry.split("\0");
    if (reference && hash === commit) return reference;
  }
  return undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
