import type { ApproveAndMergeInput } from "./types.js";
import { restoreTargetChanges as restoreStashedTargetChanges, type TargetChangesStash } from "./approve-merge-git.js";
import { appendLog } from "./cline-runtime-log.js";
import {
  asRecord,
  errorMessage,
  errorType,
  stringValue,
} from "./cline-runtime-events.js";
import { rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withoutTelemetryEnvironment } from "@blame/telemetry";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

type GitRunner = (cwd: string, args: string[]) => Promise<string>;

let customGitRunner: GitRunner | undefined;

export function setGitRunner(runner: GitRunner | undefined) {
  customGitRunner = runner;
}

export async function assertGitRepository(cwd: string) {
  await git(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function currentGitBranch(cwd: string) {
  return git(cwd, ["branch", "--show-current"]);
}

export async function validateMergeBranches(
  input: ApproveAndMergeInput,
  targetBranch: string,
) {
  await assertNoGitOperationInProgress(input.repositoryRoot);
  if (!targetBranch)
    throw new Error("Unable to detect the active project branch.");
  const storyBranch = await currentGitBranch(input.worktree);
  if (storyBranch !== input.storyBranch) {
    throw new Error(
      `Story worktree is on ${storyBranch}, expected ${input.storyBranch}.`,
    );
  }
  if (targetBranch === input.storyBranch) {
    throw new Error("Story branch and target branch must be different.");
  }
}

// A merge, cherry-pick, revert or rebase someone runs in the project
// checkout. Approving would stash it away with the local changes, and the
// stash drops its state: a merge then commits with a single parent.
const gitOperations = [
  { ref: "MERGE_HEAD", name: "merge", finish: "commit it or run git merge --abort" },
  { ref: "CHERRY_PICK_HEAD", name: "cherry-pick", finish: "run git cherry-pick --continue or --abort" },
  { ref: "REVERT_HEAD", name: "revert", finish: "run git revert --continue or --abort" },
];
const rebaseDirectories = ["rebase-merge", "rebase-apply"];

async function assertNoGitOperationInProgress(cwd: string) {
  const busy = (name: string, finish: string) =>
    new Error(
      `A Git ${name} is in progress in ${cwd}. Approve & Merge leaves it alone: ${finish}, then approve again.`,
    );
  for (const { ref, name, finish } of gitOperations)
    if (await gitRevisionExists(cwd, ref)) throw busy(name, finish);
  for (const directory of rebaseDirectories) {
    const path = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", directory]);
    if (await stat(path).then(() => true, () => false))
      throw busy("rebase", "run git rebase --continue or --abort");
  }
}

async function gitRevisionExists(cwd: string, ref: string) {
  try {
    return Boolean(await git(cwd, ["rev-parse", "--verify", "--quiet", ref]));
  } catch {
    return false;
  }
}

export async function optionalGitUpstream(cwd: string) {
  try {
    const upstream = await git(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    return parseUpstream(upstream);
  } catch {
    return undefined;
  }
}

export async function cleanGitStatus(cwd: string) {
  const status = await git(cwd, ["status", "--porcelain"]);
  return !status.trim();
}

export async function integrationWorktree(cwd: string, targetBranch: string) {
  const directory = integrationWorktreePath(cwd, targetBranch);
  await removeIntegrationWorktree(cwd, directory);
  await git(cwd, ["worktree", "add", "--detach", directory, targetBranch]);
  return directory;
}

export async function advanceTargetBranch(
  cwd: string,
  targetBranch: string,
  storyBranch: string,
) {
  const activeBranch = await currentGitBranch(cwd);
  if (activeBranch !== targetBranch) {
    throw new Error(
      `Active project branch changed to ${activeBranch}, expected ${targetBranch}.`,
    );
  }
  await git(cwd, ["merge", "--ff-only", storyBranch]);
}

export async function restoreTargetChanges(
  cwd: string,
  stash: TargetChangesStash | undefined,
  logFile: string,
) {
  if (!stash) return;
  const result = await restoreStashedTargetChanges(cwd, stash, git);
  if (result.cleanupError) {
    await appendLog(logFile, "local target changes stash cleanup failed", {
      commit: stash.commit,
      errorType: errorType(result.cleanupError),
    });
  }
  await appendLog(logFile, "local target changes restored", {
    commit: stash.commit,
  });
}

export async function pullIntegrationWorktree(cwd: string, upstream?: GitUpstream) {
  if (!upstream) return;
  await git(cwd, ["fetch", upstream.remote, upstream.branch]);
  await git(cwd, [
    "merge",
    "--ff-only",
    `${upstream.remote}/${upstream.branch}`,
  ]);
}

export async function pushIntegrationWorktree(
  cwd: string,
  upstream: GitUpstream | undefined,
  logFile: string,
) {
  if (!upstream) {
    await appendLog(logFile, "approve merge push skipped", {
      reason: "missing_upstream",
    });
    return;
  }
  await git(cwd, ["push", upstream.remote, `HEAD:${upstream.branch}`]);
}

export async function removeIntegrationWorktree(
  repositoryRoot: string,
  worktree: string,
) {
  try {
    await git(repositoryRoot, ["worktree", "remove", "--force", worktree]);
  } catch (error) {
    if (!errorMessage(error).includes("is not a working tree")) throw error;
  }
  // Only remove this operation's temporary checkout. A global prune from the
  // host would also delete registrations for worktrees stored inside the VM.
  await rm(worktree, { force: true, recursive: true });
}

export type GitUpstream = {
  branch: string;
  remote: string;
};

function parseUpstream(value: string): GitUpstream {
  const [remote, ...branchParts] = value.split("/");
  const branch = branchParts.join("/");
  if (!remote || !branch)
    throw new Error("Active project branch upstream is invalid.");
  return { branch, remote };
}

function integrationWorktreePath(repositoryRoot: string, targetBranch: string) {
  return join(
    dirname(repositoryRoot),
    ".blame-worktrees",
    basename(repositoryRoot),
    ".merge",
    branchPathSlug(targetBranch),
  );
}

function branchPathSlug(branch: string) {
  return (
    branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "target"
  );
}

export async function hasMergeConflicts(cwd: string) {
  return Boolean((await mergeConflictFiles(cwd)).length);
}

export async function hasPendingMerge(cwd: string) {
  try {
    return Boolean(
      await git(cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]),
    );
  } catch {
    return false;
  }
}

export async function mergeConflictFiles(cwd: string) {
  const files = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  return files.split("\n").filter(Boolean);
}

export async function git(cwd: string, args: string[]) {
  try {
    if (customGitRunner) {
      return (await customGitRunner(cwd, args)).trim();
    }
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: {
        ...withoutTelemetryEnvironment(process.env),
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND:
          process.platform === "win32"
            ? "ssh.exe -o BatchMode=yes -o StrictHostKeyChecking=no"
            : "ssh -o BatchMode=yes -o StrictHostKeyChecking=no",
      },
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(gitErrorMessage(args, error), { cause: error });
  }
}

function gitErrorMessage(args: string[], error: unknown) {
  const record = asRecord(error);
  const output = stringValue(record.stderr) || stringValue(record.stdout);
  const message = output?.trim() || errorMessage(error);
  return `git ${args.join(" ")} failed: ${message}`;
}
