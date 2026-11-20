// Commit messages: the Git page's and a Direct story's (generateCommitMessage),
// and the commit of a story's remaining work before it merges or opens its
// pull request. The agent writes the subject from the changes; when it fails,
// Blame writes one from the status and the recent subjects.

import {
  commitMessagePaths,
  fallbackCommitMessageFromStatus,
  type CommitMessageSubject,
} from "../../commit-message.js";
import { withLinkedIssueTrailers } from "../../linked-issues.js";
import {
  appendLog,
  approveMergeLogPath,
  commitMessageLogPath,
} from "../../runtime-log.js";
import {
  assertGitRepository,
  assertRepositoryPath,
  git,
  hasMergeConflicts,
  originRemoteUrl,
} from "../../runtime-git.js";
import {
  addStoryChanges,
  storyChangedFiles,
  storyDiffStat,
  storyStatus,
  truncateText,
} from "../../story-worktree-git.js";
import type { GenerateCommitMessageResult } from "../../types.js";
import { commitMessageTask } from "../purposes/commit-message.js";
import type {
  GenerateCommitMessageTask,
  GitFlowCall,
} from "../task-protocol.js";
import type { GitAgent } from "./agent.js";

/** What a commit message is written from: a story, or the Git page's selection. */
export type CommitMessageInput = GitFlowCall &
  CommitMessageSubject & { summary?: string };

export async function generateCommitMessage(
  input: GenerateCommitMessageTask,
  agent: GitAgent,
): Promise<GenerateCommitMessageResult> {
  assertRepositoryPath(input.repositoryRoot, "repositoryRoot");
  assertRepositoryPath(input.worktree, "worktree");
  await assertGitRepository(input.repositoryRoot);
  await assertGitRepository(input.worktree);
  const status = await storyStatus(
    input.worktree,
    "--porcelain",
    commitMessagePaths(input),
  );
  if (!status.trim())
    throw new Error(
      "No selected changes available for commit message generation.",
    );
  const logFile = commitMessageLogPath(input.worktree);
  await appendLog(logFile, "commit message generation requested", {
    providerId: input.model.providerId,
    modelId: input.model.modelId,
    reasoningEffort: input.model.reasoning,
    repositoryRoot: input.repositoryRoot,
    selectedPaths: input.selectedPaths ?? [],
    worktree: input.worktree,
  });
  const message = await writeCommitMessage(input, logFile, agent);
  // A Direct story's commit; the Git page's own commits don't ask.
  if (input.closeLinkedIssues)
    return { message: await withStoryIssueTrailers(message, input) };
  return { message };
}

/** Commits what the story left uncommitted, with its issue trailers. */
export async function commitStoryWork(
  input: CommitMessageInput & { title: string; summary: string },
  agent: GitAgent,
) {
  if (await hasMergeConflicts(input.worktree)) {
    throw new Error(
      "Resolve the active Git conflicts before committing the story.",
    );
  }
  const status = await storyStatus(input.worktree, "--porcelain");
  if (!status.trim()) return;
  const generated = await writeCommitMessage(
    input,
    approveMergeLogPath(input.worktree),
    agent,
  );
  const message = await withStoryIssueTrailers(generated, input);
  await addStoryChanges(input.worktree);
  await git(input.worktree, ["commit", "-m", message]);
  const nextStatus = await storyStatus(input.worktree, "--porcelain");
  if (nextStatus.trim())
    throw new Error(
      "Story worktree still has uncommitted changes after commit.",
    );
}

// Never fails for the agent: its message, or Blame's own.
async function writeCommitMessage(
  input: CommitMessageInput,
  logFile: string,
  agent: GitAgent,
) {
  try {
    const startedAt = Date.now();
    const spec = commitMessageTask(input, await commitMessagePrompt(input));
    const { session, result } = await agent(
      input,
      spec,
      "The commit message agent",
    );
    await appendLog(logFile, "commit message agent finished", {
      durationMs: Date.now() - startedAt,
      sessionId: session,
      status: "completed",
      success: true,
    });
    return result;
  } catch (error) {
    await appendLog(logFile, "commit message agent failed", {
      errorType: error instanceof Error ? error.constructor.name : "Error",
      status: "failed",
    });
  }
  await appendLog(logFile, "commit message fallback selected", {
    status: "fallback",
    success: true,
  });
  return fallbackCommitMessage(input);
}

export async function commitMessagePrompt(input: CommitMessageInput) {
  const paths = commitMessagePaths(input);
  const [status, changedFiles, diffStat, log] = await Promise.all([
    storyStatus(input.worktree, "--porcelain", paths),
    storyChangedFiles(input.worktree, paths),
    storyDiffStat(input.worktree, paths),
    git(input.worktree, ["log", "-12", "--pretty=%s"]),
  ]);
  const title = input.title || "Git changes";
  const summary =
    input.summary ||
    "Generate a concise commit message for the selected changes.";
  return [
    `Backlog item: ${title}`,
    "",
    summary,
    "",
    `Git status:\n${truncateText(status, 8_000)}`,
    "",
    `Selected paths:\n${truncateText(paths.join("\n"), 8_000)}`,
    "",
    `Changed files:\n${truncateText(changedFiles, 12_000)}`,
    "",
    `Diff stat:\n${truncateText(diffStat, 12_000)}`,
    "",
    `Recent commits:\n${truncateText(log, 8_000)}`,
  ].join("\n");
}

async function fallbackCommitMessage(input: CommitMessageInput) {
  const paths = commitMessagePaths(input);
  const [status, log] = await Promise.all([
    storyStatus(input.worktree, "--porcelain", paths),
    git(input.worktree, ["log", "-12", "--pretty=%s"]),
  ]);
  return fallbackCommitMessageFromStatus(input, status, log);
}

// A story's commit closes the issues of origin the story says it handles.
async function withStoryIssueTrailers(
  message: string,
  input: CommitMessageInput,
) {
  const origin = await originRemoteUrl(input.repositoryRoot);
  return withLinkedIssueTrailers(message, input, origin);
}
