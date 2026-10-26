import { isProjectFolder } from "./worktree-safety.ts";
import { workspaceExecution, type WorkspaceMode } from "./workspace-mode.ts";
import { pathExists } from "./workspace-runtime.ts";
import { runRuntimeGit, worktreeRegistered } from "./workspace-runtime-git.ts";

const removalDependencies = {
  isProjectFolder,
  pathExists,
  runGit: runRuntimeGit,
  worktreeRegistered,
};

export async function inspectWorktreeRemoval(
  input: {
    repositoryRoot: string;
    worktree: string;
    workspaceMode?: WorkspaceMode;
  },
  dependencies = removalDependencies,
) {
  const { repositoryRoot, worktree } = input;
  const mode = input.workspaceMode ?? "local-container";
  // Direct stories only release their sessions. They must never require Git
  // or reach the deletion path for the user's project folder.
  if (
    mode === "direct" ||
    (await dependencies.isProjectFolder(repositoryRoot, worktree))
  )
    return { mode, state: "project" as const };

  // The repository can be on C: while its story worktree lives in WSL.
  // Use the story's execution mode for every Git operation, including this
  // check, instead of inferring it from the repository's host path.
  await dependencies.runGit(
    repositoryRoot,
    ["rev-parse", "--show-toplevel"],
    workspaceExecution(mode),
  );
  if (await dependencies.worktreeRegistered(repositoryRoot, worktree, mode))
    return { mode, state: "registered" as const };
  return {
    mode,
    state: (await dependencies.pathExists(worktree))
      ? ("unregistered" as const)
      : ("missing" as const),
  };
}
