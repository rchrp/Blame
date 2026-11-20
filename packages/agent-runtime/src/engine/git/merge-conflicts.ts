// Merge conflicts resolved by an agent: the Git page's (resolveMergeConflicts)
// and those of a story merging its target branch. Each attempt is an engine
// task working in the worktree; the host stages the files it left without
// conflict markers, then Git says what is still conflicted.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendLog, mergeConflictLogPath } from "../../runtime-log.js";
import {
  assertGitRepository,
  assertRepositoryPath,
  currentGitBranch,
  git,
  mergeConflictFiles,
} from "../../runtime-git.js";
import { storyStatus, truncateText } from "../../story-worktree-git.js";
import type { ResolveMergeConflictsResult } from "../../types.js";
import { mergeConflictTask } from "../purposes/merge-conflicts.js";
import type {
  GitFlowCall,
  ResolveMergeConflictsTask,
} from "../task-protocol.js";
import type { GitAgent } from "./agent.js";

export const maxMergeConflictResolutionAttempts = 3;

export type MergeConflictInput = GitFlowCall & {
  title?: string;
  summary?: string;
  storyBranch?: string;
};

export async function resolveMergeConflicts(
  input: ResolveMergeConflictsTask,
  agent: GitAgent,
): Promise<ResolveMergeConflictsResult> {
  assertRepositoryPath(input.repositoryRoot, "repositoryRoot");
  assertRepositoryPath(input.worktree, "worktree");
  const logFile = mergeConflictLogPath(input.worktree);
  await appendLog(logFile, "merge conflict resolution requested", {
    providerId: input.model.providerId,
    modelId: input.model.modelId,
    reasoningEffort: input.model.reasoning,
    repositoryRoot: input.repositoryRoot,
    worktree: input.worktree,
  });
  await assertGitRepository(input.repositoryRoot);
  await assertGitRepository(input.worktree);
  const targetBranch =
    input.targetBranch || (await currentGitBranch(input.worktree)) || "HEAD";
  await resolveConflictsWithAgent(input, targetBranch, logFile, agent, false);
  const conflicts = await mergeConflictFiles(input.worktree);
  return { conflicts, resolved: conflicts.length === 0 };
}

export async function resolveConflictsWithAgent(
  input: MergeConflictInput,
  targetBranch: string,
  logFile: string,
  agent: GitAgent,
  throwOnUnresolved = true,
) {
  let conflicts = await mergeConflictFiles(input.worktree);
  for (
    let attempt = 1;
    attempt <= maxMergeConflictResolutionAttempts && conflicts.length;
    attempt += 1
  ) {
    const resolution = await runMergeConflictAgent(
      input,
      targetBranch,
      attempt,
      logFile,
      agent,
    );
    await stageResolvedFiles(input.worktree, conflicts);
    conflicts = await mergeConflictFiles(input.worktree);
    await appendLog(logFile, "merge conflict agent finished", {
      status: conflicts.length ? "conflicts_remaining" : "resolved",
      success: !conflicts.length,
    });
    if (!resolution.resolved && conflicts.length)
      throw new Error(
        resolution.reason
          ? `The merge conflict agent could not resolve the conflicts: ${resolution.reason}`
          : "The merge conflict agent could not resolve the conflicts.",
      );
  }
  if (conflicts.length && throwOnUnresolved)
    throw new Error(unresolvedMergeConflictMessage(conflicts));
}

export function unresolvedMergeConflictMessage(conflicts: string[]) {
  return `Merge conflict agent finished with unresolved conflicts: ${conflicts.join(", ")}`;
}

async function runMergeConflictAgent(
  input: MergeConflictInput,
  targetBranch: string,
  attempt: number,
  logFile: string,
  agent: GitAgent,
) {
  const startedAt = Date.now();
  const spec = mergeConflictTask(
    input,
    await mergeConflictPrompt(input, targetBranch, attempt),
  );
  const { session, result } = await agent(
    input,
    spec,
    "The merge conflict agent",
  );
  await appendLog(logFile, "merge conflict agent run completed", {
    durationMs: Date.now() - startedAt,
    sessionId: session,
    status: result.resolved ? "resolved" : "unresolved",
  });
  return result;
}

async function mergeConflictPrompt(
  input: MergeConflictInput,
  targetBranch: string,
  attempt: number,
) {
  const [status, files] = await Promise.all([
    storyStatus(input.worktree, "--short"),
    git(input.worktree, ["diff", "--name-only", "--diff-filter=U"]),
  ]);
  const title = input.title || "Current Git merge conflict";
  const summary = input.summary || "Resolve the active merge conflicts.";
  const storyBranch =
    input.storyBranch || (await currentGitBranch(input.worktree));
  return [
    `Backlog item: ${title}`,
    "",
    summary,
    "",
    `Story branch: ${storyBranch || "HEAD"}`,
    `Target branch: ${targetBranch}`,
    `Resolution attempt: ${attempt} of ${maxMergeConflictResolutionAttempts}`,
    "",
    `Conflicted files:\n${files}`,
    "",
    `Git status:\n${truncateText(status, 8_000)}`,
  ].join("\n");
}

const conflictMarker = /^(?:<{7}|\|{7}|>{7})(?: |$)/mu;

/**
 * The agent cannot stage (git mutations stay out of its commands): a file
 * it left without conflict markers, or deleted, is resolved and staged here.
 */
async function stageResolvedFiles(worktree: string, files: string[]) {
  const resolved: string[] = [];
  for (const file of files) {
    const content = await readFile(join(worktree, file), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    if (!conflictMarker.test(content)) resolved.push(file);
  }
  if (resolved.length) await git(worktree, ["add", "-A", "--", ...resolved]);
}
