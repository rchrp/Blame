// Open PR: commits the story's remaining work, pushes its branch from the
// project checkout (which owns the remote credentials) and opens its GitHub
// pull request with gh, in English, or finds the one already open. It runs
// with the merges of its repository: both commit in the story worktree and
// read the target branch.

import { linkedIssueNumbers } from "../../linked-issues.js";
import {
  createPullRequest,
  openPullRequestUrl,
  pullRequestBody,
  requirePullRequestRepository,
} from "../../pull-request.js";
import { runRepositoryMerge } from "../../repository-merge-queue.js";
import { appendLog, pullRequestLogPath } from "../../runtime-log.js";
import {
  assertGitRepository,
  assertRepositoryPath,
  currentGitBranch,
  git,
  originRemoteUrl,
  validateMergeBranches,
} from "../../runtime-git.js";
import { removeRuntimeEnvChanges } from "../../story-worktree-git.js";
import type { OpenPullRequestResult } from "../../types.js";
import {
  pullRequestTextTask,
  type PullRequestText,
} from "../purposes/pull-request-text.js";
import type { OpenPullRequestTask } from "../task-protocol.js";
import { EngineTaskError } from "../tasks/runner.js";
import type { GitFlowServices } from "./agent.js";
import { commitStoryWork } from "./commit-message.js";
import { storyMergeContext } from "./story-merge.js";

export function openPullRequest(
  input: OpenPullRequestTask,
  services: GitFlowServices,
): Promise<OpenPullRequestResult> {
  return runRepositoryMerge(input.repositoryRoot, () =>
    openPullRequestOperation(input, services),
  );
}

async function openPullRequestOperation(
  input: OpenPullRequestTask,
  services: GitFlowServices,
): Promise<OpenPullRequestResult> {
  const { gh } = services;
  assertRepositoryPath(input.repositoryRoot, "repositoryRoot");
  assertRepositoryPath(input.worktree, "worktree");
  const logFile = pullRequestLogPath(input.worktree);
  await appendLog(logFile, "pull request requested", storyMergeContext(input));
  await assertGitRepository(input.repositoryRoot);
  await assertGitRepository(input.worktree);
  const targetBranch =
    input.targetBranch?.trim() ||
    (await currentGitBranch(input.repositoryRoot));
  await validateMergeBranches(input, targetBranch);
  // Checked before anything is committed or pushed.
  const repository = await requirePullRequestRepository(
    input.repositoryRoot,
    gh,
  );
  await commitStoryWork(input, services.agent);
  // Runtime env files stay out of GitHub, as they stay out of merges.
  const forkPoint = await git(input.repositoryRoot, [
    "merge-base",
    `refs/heads/${targetBranch}`,
    `refs/heads/${input.storyBranch}`,
  ]);
  await removeRuntimeEnvChanges(input.worktree, forkPoint);
  // The project checkout owns the remote credentials; the story worktree
  // may run in a VM without them.
  await git(input.repositoryRoot, [
    "push",
    "origin",
    `refs/heads/${input.storyBranch}:refs/heads/${input.storyBranch}`,
  ]);
  const existingUrl = await openPullRequestUrl(
    input.repositoryRoot,
    repository,
    input.storyBranch,
    gh,
  );
  const url =
    existingUrl ??
    (await createEnglishPullRequest(
      input,
      { repository, targetBranch },
      logFile,
      services,
    ));
  await appendLog(logFile, "pull request ready", {
    created: !existingUrl,
    repository,
    targetBranch,
    url,
  });
  return { url, created: !existingUrl, targetBranch };
}

async function createEnglishPullRequest(
  input: OpenPullRequestTask,
  destination: { repository: string; targetBranch: string },
  logFile: string,
  services: GitFlowServices,
) {
  const text = await englishPullRequestText(input, logFile, services);
  // From the story as written: its English rewrite may drop the links.
  const origin = await originRemoteUrl(input.repositoryRoot);
  const issues = linkedIssueNumbers(input, origin);
  return createPullRequest(
    input.repositoryRoot,
    {
      body: pullRequestBody(text, issues),
      repository: destination.repository,
      storyBranch: input.storyBranch,
      targetBranch: destination.targetBranch,
      title: text.title,
    },
    services.gh,
  );
}

// Failing is retryable: the work is already pushed, so opening the pull
// request again only repeats this step.
async function englishPullRequestText(
  input: OpenPullRequestTask,
  logFile: string,
  services: GitFlowServices,
): Promise<PullRequestText> {
  const startedAt = Date.now();
  const spec = pullRequestTextTask(input);
  try {
    const { session, result } = await services.agent(
      input,
      spec,
      "The pull request agent",
    );
    await appendLog(logFile, "pull request text agent finished", {
      durationMs: Date.now() - startedAt,
      sessionId: session,
      status: "completed",
      success: true,
    });
    return result;
  } catch (error) {
    if (!unwritten(error)) throw error;
    await appendLog(logFile, "pull request text agent finished", {
      durationMs: Date.now() - startedAt,
      sessionId: error.session,
      status: "failed",
      success: false,
    });
    throw new Error(
      "The agent did not write the pull request in English. Open the pull request again to retry.",
      { cause: error },
    );
  }
}

// The agent never gave its text: a provider or limit failure says more as it is.
function unwritten(error: unknown): error is EngineTaskError {
  return (
    error instanceof EngineTaskError &&
    error.outcome.status === "failed" &&
    error.outcome.failure.kind === "contract_unmet"
  );
}
