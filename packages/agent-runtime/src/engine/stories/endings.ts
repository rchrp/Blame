// How a story's work ends: approved and merged into its target branch
// through the git flow, or done, discarded, sent back to the backlog or
// deleted; and what each leaves of its runtime (its agent, setup,
// previews, worktree).

import type { ApproveAndMergeResult } from "../../types.js";
import type { EngineModelChoice } from "../protocol.js";
import { effectiveCodePractices } from "./settings.js";
import { errorMessage, type StoryContext } from "./start.js";
import { inactiveStoryFields, storyLocation, type HostStory } from "./story.js";

// Written by a story's agent when it repaired the project's preview setup.
const previewRepairPath = ".blame/initialization/preview-repair.json";

/** The statuses a story has a runtime in (a worktree, a preview, an agent). */
export function hasRuntime(status: HostStory["status"]) {
  return status === "in-progress" || status === "in-review";
}

/**
 * Approve & Merge: the story's remaining work committed and merged into
 * its target branch (an agent resolves conflicts), its target pushed when
 * asked. While it runs the story shows Running in review. Returns the
 * merged story; its runtime is cleaned afterwards (`cleanStory`).
 */
export async function approveStory(
  context: StoryContext,
  story: HostStory,
  projectPath: string,
  input: { push?: boolean; model: EngineModelChoice },
): Promise<{
  merged: HostStory;
  merge: ApproveAndMergeResult;
  previewRepairCandidate?: unknown;
}> {
  if (story.status !== "in-review")
    throw new Error("Only a story in review can be approved and merged.");
  if (!story.worktree)
    throw new Error("This user story has no active worktree.");
  if (!story.branch) throw new Error("This user story has no feature branch.");
  const worktree = story.worktree;
  const running = await context.patch(story, {
    agentLastError: null,
    agentStatus: "Running",
  });
  let merge: ApproveAndMergeResult;
  try {
    const { practices } = await context.api.initialization(story.projectId);
    const flow = await required(context.desktop.beginGitFlow)({
      method: "approveAndMerge",
      worktree,
    });
    try {
      merge = await context.call("approveAndMerge", {
        model: input.model,
        projectId: story.projectId,
        repositoryRoot: projectPath,
        worktree,
        storyBranch: story.branch,
        targetBranch: story.targetBranch ?? undefined,
        push: input.push,
        title: story.title,
        summary: story.summary,
        codePractices: effectiveCodePractices(practices),
        inVm: flow.inVm,
        activeWorktrees: flow.activeWorktrees,
      });
    } finally {
      await context.desktop.endGitFlow?.({ operation: flow.operation });
    }
  } catch (error) {
    // A write that fails here is the reconcile's to redo (a merge stopped).
    await context
      .patchDurably(running, {
        agentLastError: errorMessage(error),
        agentStatus: null,
      })
      .catch(() => undefined);
    throw error;
  }
  const previewRepairCandidate = await readPreviewRepair(context, worktree);
  const merged = await context.patchDurably(running, {
    ...inactiveStoryFields(),
    agentLastError: null,
    baseCommit: merge.baseCommit,
    mergeCommit: merge.mergeCommit,
    mergedAt: new Date().toISOString(),
    status: "done",
  });
  return {
    merged,
    merge,
    ...(previewRepairCandidate !== undefined ? { previewRepairCandidate } : {}),
  };
}

/**
 * Stops what the story runs and removes its worktree: its agent (and, for
 * a story done with it, its session: the account keeps its copy of the
 * conversation), its setup, previews and devices, then the worktree (never
 * the project folder).
 */
export async function cleanStory(
  context: StoryContext,
  story: HostStory,
  projectPath: string | undefined,
  options: { removeSession: boolean },
) {
  const [, runtime] = await Promise.all([
    stopAgent(context, story, options.removeSession),
    context.desktop.stopStoryRuntime?.({
      storyId: story.id,
      worktree: story.worktree,
      workspaceMode: story.workspaceMode,
    }),
  ]);
  if (!story.worktree) return;
  if (!projectPath) throw new Error("Unable to resolve repository root.");
  await required(context.desktop.removeStoryWorktree)({
    repositoryRoot: projectPath,
    worktree: story.worktree,
    workspaceMode: story.workspaceMode,
    projectSetupStopped: runtime?.projectSetupStopped ?? false,
  });
}

// Stops the story's agent if a turn runs, and removes its session when the
// story is done with it (its tools are released).
async function stopAgent(
  context: StoryContext,
  story: HostStory,
  removeSession: boolean,
) {
  const session = story.engineSessionId;
  if (!session) return;
  const location = storyLocation(story.workspaceMode);
  await context.call("interrupt", { session, location }).catch(() => undefined);
  if (removeSession)
    await context
      .call("deleteSession", { session, location })
      .catch(() => undefined);
}

async function readPreviewRepair(context: StoryContext, worktree: string) {
  const text = await context.desktop
    .readWorkspaceFile?.({ root: worktree, path: previewRepairPath })
    .catch(() => null);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function required<Input, Output>(
  service: ((input: Input) => Promise<Output>) | undefined,
) {
  if (!service)
    throw new Error("The desktop cannot run development stories here.");
  return service;
}
