// The epic's branch (docs/orchestrator.md, "The epic"): `epic/<slug>`,
// created from the epic's target branch (the project folder's current
// branch when the epic names none) without checking anything out, so the
// person's folder and its branch never move. Stories target it; Approve &
// Merge moves it where it is checked out nowhere.

export type GitRun = (cwd: string, args: string[]) => Promise<string>;

/** A branch name's part for a title: lowercase words joined by dashes. */
export function epicSlug(title: string, epicId: string) {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || `epic-${epicId.slice(0, 8).toLowerCase()}`;
}

/** The project folder's current branch; refused when it is on none. */
export async function currentBranch(git: GitRun, root: string) {
  const branch = (
    await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
  ).trim();
  if (!branch || branch === "HEAD")
    throw new Error(
      "The project folder is on no branch (a detached HEAD): check out the branch the epic merges into.",
    );
  return branch;
}

async function branchExists(git: GitRun, root: string, branch: string) {
  try {
    await git(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/** A name for a new epic's branch that no branch and no other epic uses. */
export async function newEpicBranch(
  git: GitRun,
  root: string,
  input: { title: string; epicId: string; taken: readonly string[] },
) {
  const base = `epic/${epicSlug(input.title, input.epicId)}`;
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? base : `${base}-${index}`;
    if (input.taken.includes(name)) continue;
    if (!(await branchExists(git, root, name))) return name;
  }
}

/** Creates the branch from the target when it is missing (a quit cut its creation). */
export async function ensureBranch(
  git: GitRun,
  root: string,
  branch: string,
  targetBranch: string,
) {
  if (await branchExists(git, root, branch)) return;
  if (!(await branchExists(git, root, targetBranch)))
    throw new Error(
      `The epic's target branch ${targetBranch} does not exist in the project.`,
    );
  await git(root, ["branch", branch, targetBranch]);
}
