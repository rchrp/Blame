import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

// A story worktree can be removed; a project folder never can. Direct mode
// runs stories in the project folder itself, and a removal that fell back to
// deleting the folder would erase the user's project. Every removal checks
// this first.
export async function isProjectFolder(
  repositoryRoot: string,
  worktree: string,
  directoryExists: (path: string) => Promise<boolean> = hostDirectoryExists,
) {
  if (samePath(repositoryRoot, worktree)) return true;
  // A linked worktree has a `.git` file; the main working tree has a `.git`
  // directory.
  return directoryExists(join(worktree, ".git"));
}

export function samePath(left: string, right: string) {
  return normalized(left) === normalized(right);
}

function normalized(path: string) {
  const absolute = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/")
    ? path
    : resolve(path);
  return absolute.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

async function hostDirectoryExists(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
