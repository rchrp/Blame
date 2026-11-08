import { resolveWorkspacePath as resolveRuntimePath } from "../workspace-runtime.ts";
import { runRuntimeGit } from "../workspace-runtime-git.ts";

// The branches a story can start from and merge into.

export type GitBranchList = {
  // Null when the folder is on a detached HEAD.
  current: string | null;
  local: string[];
  // Remote branches with no local branch yet, such as "origin/feature".
  remote: string[];
};

export type GitTrackBranchInput = {
  remoteBranch: string;
  root: string;
};

export type GitPublishBranchInput = {
  branch: string;
  remote: string;
  root: string;
};

export async function gitBranches(root: string): Promise<GitBranchList> {
  const cwd = resolveRuntimePath(root);
  const [current, refs] = await Promise.all([
    runRuntimeGit(cwd, ["branch", "--show-current"]),
    runRuntimeGit(cwd, [
      "for-each-ref",
      "--format=%(refname)%09%(upstream:short)",
      "refs/heads",
      "refs/remotes",
    ]),
  ]);
  return parseGitBranches(current.stdout.trim(), refs.stdout);
}

function parseGitBranches(current: string, refs: string): GitBranchList {
  const local: string[] = [];
  const remote: string[] = [];
  const tracked = new Set<string>();
  for (const line of refs.split("\n")) {
    const [ref = "", upstream = ""] = line.trim().split("\t");
    if (ref.startsWith("refs/heads/")) {
      local.push(ref.slice("refs/heads/".length));
      if (upstream) tracked.add(upstream);
    } else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) {
      remote.push(ref.slice("refs/remotes/".length));
    }
  }
  const localNames = new Set(local);
  return {
    current: current || null,
    local,
    remote: remote.filter(
      (branch) =>
        !tracked.has(branch) && !localNames.has(remoteBranchLocalName(branch)),
    ),
  };
}

// Creates the local branch that follows a remote-only branch.
export async function gitTrackRemoteBranch(input: GitTrackBranchInput) {
  const cwd = resolveRuntimePath(input.root);
  const remoteBranch = gitBranchName(input.remoteBranch);
  const branch = remoteBranchLocalName(remoteBranch);
  if (!branch) throw new Error(`${remoteBranch} is not a remote branch.`);
  try {
    await runRuntimeGit(cwd, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/${remoteBranch}`,
    ]);
  } catch {
    throw new Error(`Remote branch ${remoteBranch} does not exist.`);
  }
  await runRuntimeGit(cwd, ["branch", "--track", branch, remoteBranch]);
  return { branch };
}

// push -u for a branch that has no upstream yet.
export async function gitPublishBranch(input: GitPublishBranchInput) {
  const cwd = resolveRuntimePath(input.root);
  const branch = gitBranchName(input.branch);
  const remote = gitBranchName(input.remote);
  const result = await runRuntimeGit(cwd, ["push", "-u", remote, branch]);
  return { output: result.stdout || result.stderr };
}

function remoteBranchLocalName(remoteBranch: string) {
  const separator = remoteBranch.indexOf("/");
  return separator > 0 ? remoteBranch.slice(separator + 1) : "";
}

// Branch and remote names reach Git as arguments: never as options.
function gitBranchName(value: string) {
  const name = value.trim();
  if (
    !name ||
    name.startsWith("-") ||
    /[\s~^:?*[\\]|\.\.|@\{|\/\/|\.lock$|\/$|\.$/.test(name)
  )
    throw new Error("Invalid Git branch name");
  return name;
}
