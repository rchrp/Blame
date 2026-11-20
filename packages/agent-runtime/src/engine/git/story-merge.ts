// Approve & Merge: commits the story's remaining work, merges its target
// branch into it (an agent resolves conflicts), then fast-forwards the
// target branch to the story wherever it is checked out, and pushes it when
// asked. One merge at a time per repository.

import {
  assertTargetChangesRestorable,
  stashTargetChanges,
  type TargetChangesStash,
} from "../../approve-merge-git.js";
import { runRepositoryMerge } from "../../repository-merge-queue.js";
import { appendLog, approveMergeLogPath } from "../../runtime-log.js";
import {
  advanceTargetBranch,
  assertGitRepository,
  assertRepositoryPath,
  cleanGitStatus,
  currentGitBranch,
  defaultPushRemote,
  git,
  hasMergeConflicts,
  hasPendingMerge,
  integrationWorktree,
  mergeConflictFiles,
  optionalGitUpstream,
  pullIntegrationWorktree,
  pushTargetBranch,
  removeIntegrationWorktree,
  restoreTargetChanges,
  samePath,
  targetBranchCheckout,
  updateDetachedTargetBranch,
  validateMergeBranches,
  type GitUpstream,
} from "../../runtime-git.js";
import {
  addStoryChanges,
  removeRuntimeEnvChanges,
} from "../../story-worktree-git.js";
import type {
  ApproveAndMergePush,
  ApproveAndMergeResult,
} from "../../types.js";
import type {
  ApproveAndMergeTask,
  OpenPullRequestTask,
} from "../task-protocol.js";
import type { GitAgent } from "./agent.js";
import { commitStoryWork } from "./commit-message.js";
import {
  resolveConflictsWithAgent,
  unresolvedMergeConflictMessage,
} from "./merge-conflicts.js";

type StoryMergePreparation = {
  baseCommit: string;
  integration: string;
  placement: StoryMergePlacement;
  previousTargetCommit: string;
  targetBranch: string;
  upstream?: GitUpstream;
};

// How the target branch is advanced, from where it is checked out.
type StoryMergePlacement =
  // In its own checkout: the clean project folder or another worktree.
  | "in-place"
  // In the project folder with local changes, stashed around the merge.
  | "stash"
  // Checked out nowhere: moved by update-ref from a temporary checkout.
  | "detached";

export function approveAndMerge(
  input: ApproveAndMergeTask,
  agent: GitAgent,
): Promise<ApproveAndMergeResult> {
  return runRepositoryMerge(input.repositoryRoot, () =>
    approveAndMergeOperation(input, agent),
  );
}

async function approveAndMergeOperation(
  input: ApproveAndMergeTask,
  agent: GitAgent,
): Promise<ApproveAndMergeResult> {
  assertRepositoryPath(input.repositoryRoot, "repositoryRoot");
  assertRepositoryPath(input.worktree, "worktree");
  const logFile = approveMergeLogPath(input.worktree);
  await appendLog(logFile, "approve merge requested", storyMergeContext(input));
  const preparation = await prepareStoryMerge(input);
  try {
    // A previous approval may have stopped with an unresolved merge. Resolve
    // its index before the ordinary commit path can stage conflict markers.
    await completePendingStoryMerge(input, preparation.targetBranch, agent);
    await commitStoryWork(input, agent);
    await mergeTargetIntoStory(
      input,
      preparation.targetBranch,
      preparation.baseCommit,
      agent,
    );
    await removeRuntimeEnvChanges(input.worktree, preparation.baseCommit);
    return await finalizeStoryMerge(input, logFile, preparation);
  } finally {
    if (preparation.placement !== "in-place") {
      await removeIntegrationWorktree(
        input.repositoryRoot,
        preparation.integration,
      );
    }
  }
}

/** What the logs say of a merge or a pull request. */
export function storyMergeContext(input: OpenPullRequestTask) {
  return {
    providerId: input.model.providerId,
    modelId: input.model.modelId,
    reasoningEffort: input.model.reasoning,
    repositoryRoot: input.repositoryRoot,
    worktree: input.worktree,
    storyBranch: input.storyBranch,
    targetBranch: input.targetBranch,
  };
}

async function prepareStoryMerge(
  input: ApproveAndMergeTask,
): Promise<StoryMergePreparation> {
  await assertGitRepository(input.repositoryRoot);
  await assertGitRepository(input.worktree);
  // Stories created before the target branch was recorded merge into the
  // branch checked out in the project folder, as they always did.
  const targetBranch =
    input.targetBranch?.trim() ||
    (await currentGitBranch(input.repositoryRoot));
  await validateMergeBranches(input, targetBranch);
  const upstream = await optionalGitUpstream(
    input.repositoryRoot,
    targetBranch,
  );
  const previousTargetCommit = await git(input.repositoryRoot, [
    "rev-parse",
    `refs/heads/${targetBranch}`,
  ]);
  const { integration, placement } = await storyMergeIntegration(
    input,
    targetBranch,
  );
  try {
    await pullIntegrationWorktree(input.repositoryRoot, integration, upstream);
    const baseCommit = await git(integration, ["rev-parse", "HEAD"]);
    return {
      baseCommit,
      integration,
      placement,
      previousTargetCommit,
      targetBranch,
      upstream,
    };
  } catch (error) {
    if (placement !== "in-place") {
      await removeIntegrationWorktree(input.repositoryRoot, integration);
    }
    throw error;
  }
}

async function finalizeStoryMerge(
  input: ApproveAndMergeTask,
  logFile: string,
  preparation: StoryMergePreparation,
): Promise<ApproveAndMergeResult> {
  const {
    baseCommit,
    integration,
    placement,
    previousTargetCommit,
    targetBranch,
    upstream,
  } = preparation;
  let targetChanges: TargetChangesStash | undefined;
  try {
    if (placement === "stash") {
      targetChanges = await stashTargetChanges(input.repositoryRoot, git);
      if (targetChanges) {
        await appendLog(logFile, "local target changes stashed", {
          commit: targetChanges.commit,
        });
      }
    }
    await git(integration, ["merge", "--ff-only", input.storyBranch]);
    const mergeCommit = await git(integration, ["rev-parse", "HEAD"]);
    if (placement === "stash") {
      await assertTargetChangesRestorable(integration, targetChanges, git);
      await advanceTargetBranch(
        input.repositoryRoot,
        targetBranch,
        input.storyBranch,
      );
      const changesToRestore = targetChanges;
      targetChanges = undefined;
      await restoreTargetChanges(
        input.repositoryRoot,
        changesToRestore,
        logFile,
      );
    }
    if (placement === "detached") {
      await updateDetachedTargetBranch(
        input.repositoryRoot,
        targetBranch,
        mergeCommit,
        previousTargetCommit,
      );
    }
    const push = await publishMergedTarget(
      input,
      targetBranch,
      upstream,
      logFile,
    );
    await appendLog(logFile, "approve merge completed", {
      baseCommit,
      mergeCommit,
      placement,
      targetBranch,
    });
    return { baseCommit, mergeCommit, push, targetBranch };
  } finally {
    if (targetChanges) {
      await restoreTargetChanges(input.repositoryRoot, targetChanges, logFile);
    }
  }
}

async function publishMergedTarget(
  input: ApproveAndMergeTask,
  targetBranch: string,
  upstream: GitUpstream | undefined,
  logFile: string,
): Promise<ApproveAndMergePush> {
  if (input.push !== true) {
    await appendLog(logFile, "approve merge push skipped", {
      reason: "not requested",
    });
    return { status: "skipped" };
  }
  await pushTargetBranch(input.repositoryRoot, targetBranch, upstream, logFile);
  return upstream
    ? { status: "pushed", upstream: `${upstream.remote}/${upstream.branch}` }
    : {
        status: "no-upstream",
        remote: await defaultPushRemote(input.repositoryRoot),
      };
}

async function mergeTargetIntoStory(
  input: ApproveAndMergeTask,
  targetBranch: string,
  targetCommit: string,
  agent: GitAgent,
) {
  // Preparation fetched through the project checkout, which owns remote
  // credentials. Reuse its exact target, including unpublished local commits;
  // the story worktree may run in a VM without those credentials.
  try {
    await git(input.worktree, ["merge", targetCommit]);
    return;
  } catch (error) {
    if (!(await hasMergeConflicts(input.worktree))) throw error;
  }
  try {
    await completePendingStoryMerge(input, targetBranch, agent);
  } catch (error) {
    // Story work was committed before this merge. Restore that usable revision
    // if the resolver fails, rather than leave the preview on conflict markers.
    try {
      await git(input.worktree, ["merge", "--abort"]);
    } catch (abortError) {
      throw new AggregateError(
        [error, abortError],
        `Merge resolution failed and Git could not abort the merge: ${errorMessage(abortError)}`,
        { cause: abortError },
      );
    }
    throw error;
  }
}

async function completePendingStoryMerge(
  input: ApproveAndMergeTask,
  targetBranch: string,
  agent: GitAgent,
) {
  if (!(await hasPendingMerge(input.worktree))) return;
  await resolveConflictsWithAgent(
    input,
    targetBranch,
    approveMergeLogPath(input.worktree),
    agent,
  );
  const conflicts = await mergeConflictFiles(input.worktree);
  if (conflicts.length)
    throw new Error(unresolvedMergeConflictMessage(conflicts));
  await addStoryChanges(input.worktree);
  await git(input.worktree, ["commit", "--no-edit"]);
}

// Where the target branch can be fast-forwarded to the story: its own
// checkout when that is safe, otherwise a temporary detached one.
async function storyMergeIntegration(
  input: ApproveAndMergeTask,
  targetBranch: string,
): Promise<{ integration: string; placement: StoryMergePlacement }> {
  const checkout = await targetBranchCheckout(
    input.repositoryRoot,
    targetBranch,
  );
  if (checkout.kind === "worktree") {
    await assertTargetWorktreeAvailable(input, targetBranch, checkout.path);
    return { integration: checkout.path, placement: "in-place" };
  }
  if (
    checkout.kind === "project" &&
    (await cleanGitStatus(input.repositoryRoot))
  )
    return { integration: input.repositoryRoot, placement: "in-place" };
  return {
    integration: await integrationWorktree(input.repositoryRoot, targetBranch),
    placement: checkout.kind === "project" ? "stash" : "detached",
  };
}

// Another worktree, often another story, holds the target branch: it moves
// there only when nothing would be lost or raced.
async function assertTargetWorktreeAvailable(
  input: ApproveAndMergeTask,
  targetBranch: string,
  worktree: string,
) {
  for (const active of input.activeWorktrees ?? []) {
    if (await samePath(active, worktree))
      throw new Error(
        `${targetBranch} is checked out in ${worktree}, where an agent is running. Approve & Merge again once it stops.`,
      );
  }
  if (!(await cleanGitStatus(worktree)))
    throw new Error(
      `${targetBranch} is checked out in ${worktree}, which has uncommitted changes. Commit or stash them there, then approve again.`,
    );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
