// The person's review of a finished epic (docs/orchestrator.md, "The
// review"): the epic's branch merged into its target with the same Approve &
// Merge flow a story takes (the target merged into the branch first, an
// agent resolving conflicts, then the target fast-forwarded), or its pull
// request opened. Both run in a checkout of the epic's branch: its own when
// the person checked it out (clean), else a temporary worktree.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApiConnection,
  ApproveAndMergeResult,
  OpenPullRequestResult,
} from "../../types.js";
import type {
  EngineHostInput,
  EngineHostMethod,
  EngineHostResult,
  Epic,
  EpicReviewInput,
  EpicReviewResult,
  EpicState,
  EngineModelChoice,
} from "../protocol.js";
import type { StoryService } from "../stories/service.js";
import { storyDisplayId, type HostStory } from "../stories/story.js";
import type { GitRun } from "./branch.js";
import { epicApi } from "./epics.js";
import type { EpicReading } from "./reading.js";

export type { EpicReviewInput } from "../protocol.js";

/** What the review needs of the orchestrator service. */
export type ReviewOrchestrator = {
  reading(epicId: string): Promise<EpicReading>;
  epicState(epicId: string): Promise<EpicState>;
  changed(epicId: string): Promise<EpicState>;
  orchestratorModel(
    epic: Epic,
    sent?: EngineModelChoice,
  ): EngineModelChoice | undefined;
};

/** What the review needs of the engine host. */
export type ReviewHost = {
  api(): ApiConnection | undefined;
  stories: StoryService;
  call<M extends EngineHostMethod>(
    method: M,
    input: EngineHostInput<M>,
  ): Promise<EngineHostResult<M>>;
  git?: GitRun;
};

export async function reviewEpic(
  orchestrator: ReviewOrchestrator,
  host: ReviewHost,
  input: EpicReviewInput,
): Promise<EpicReviewResult> {
  const connection = host.api();
  if (!connection) throw new Error("Sign in to review the epic.");
  const git = host.git;
  if (!git) throw new Error("Git is not available here.");
  const look = await orchestrator.reading(input.epicId);
  await host.stories.refresh(look.epic.projectId);
  const { epic, entry } = look;
  const root = entry?.settings?.workspace.root;
  if (!entry || !root)
    throw new Error(
      "This epic's conversation runs on another computer: review it there.",
    );
  if (epic.status === "completed")
    throw new Error("The epic is already merged.");
  if (epic.status === "discarded") throw new Error("The epic was discarded.");
  const branch = entry.branch;
  const target = epic.targetBranch;
  if (!branch || epic.branch !== branch || !target || branch === target)
    throw new Error(
      "The epic's branch is not the one Blame made for it, so it is not merged.",
    );
  if (entry.branchGone)
    throw new Error(`The epic's branch ${branch} is gone: restore it first.`);
  assertStoriesSettled(look.epicStories());
  const state = await orchestrator.epicState(epic.id);
  if (state.conversation === "working")
    throw new Error(
      "The orchestrator is working: wait for its turn to end, or stop it.",
    );
  const model = orchestrator.orchestratorModel(epic, entry.settings?.model);
  if (!model)
    throw new Error(
      "Choose the orchestrator's model first: it writes the merge's messages.",
    );
  const summary = state.summary ?? epic.goal ?? epic.title;
  const checkout = await epicCheckout(git, root, branch);
  try {
    const flow = {
      model,
      projectId: epic.projectId,
      repositoryRoot: root,
      worktree: checkout.path,
      storyBranch: branch,
      targetBranch: target,
      title: epic.title,
      summary,
    };
    const api = epicApi(connection);
    if (input.action === "merge") {
      const merge: ApproveAndMergeResult = await host.call("approveAndMerge", {
        ...flow,
        push: input.push === true,
      });
      const updated = await api.update(epic.id, {
        status: "completed",
        mergedAt: new Date().toISOString(),
        mergeCommit: merge.mergeCommit,
      });
      await orchestrator.changed(epic.id);
      return {
        action: "merge",
        epic: updated,
        targetBranch: merge.targetBranch,
        mergeCommit: merge.mergeCommit,
        push: { status: merge.push.status },
      };
    }
    const pull: OpenPullRequestResult = await host.call("openPullRequest", {
      ...flow,
      agentSummary: summary,
    });
    const updated = await api.update(epic.id, {
      settings: { ...epic.settings, pullRequestUrl: pull.url },
    });
    await orchestrator.changed(epic.id);
    return {
      action: "pull-request",
      epic: updated,
      url: pull.url,
      created: pull.created,
    };
  } finally {
    await checkout.release();
  }
}

/** Every story is merged or rejected, and at least one was merged. */
function assertStoriesSettled(stories: readonly HostStory[]) {
  const open = stories.filter(
    (story) => story.status !== "done" && story.status !== "discarded",
  );
  if (open.length)
    throw new Error(
      `${open.map(storyDisplayId).join(", ")} ${open.length === 1 ? "is" : "are"} neither merged nor rejected yet: let the orchestrator finish first.`,
    );
  if (!stories.some((story) => story.status === "done"))
    throw new Error("No story was merged into the epic's branch.");
}

/**
 * Where the epic's branch is checked out for the flow: the person's own
 * checkout of it when clean, else a temporary worktree removed afterwards.
 */
async function epicCheckout(git: GitRun, root: string, branch: string) {
  const listed = await git(root, ["worktree", "list", "--porcelain"]);
  const existing = checkedOutAt(listed, branch);
  if (existing) {
    const changes = await git(existing, ["status", "--porcelain"]);
    if (changes.trim())
      throw new Error(
        `${branch} is checked out in ${existing} with uncommitted changes: commit or stash them there first.`,
      );
    return { path: existing, release: async () => undefined };
  }
  const path = await mkdtemp(join(tmpdir(), "blame-epic-"));
  try {
    await git(root, ["worktree", "add", path, branch]);
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    release: async () => {
      await git(root, ["worktree", "remove", "--force", path]).catch(
        () => undefined,
      );
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      await git(root, ["worktree", "prune"]).catch(() => undefined);
    },
  };
}

/** The path where `branch` is checked out, from `git worktree list --porcelain`. */
export function checkedOutAt(listing: string, branch: string) {
  let path: string | undefined;
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}
