import type { PullRequestState } from "@blame/agent-runtime"

import type {
  UserStory,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import { inactiveStoryFields } from "./story-runtime-state.ts"

// A story in review whose pull request is open on GitHub follows what
// happens to it there: merged is Done, closed without merge gives back Reject
// and Approve & Merge. An approved pull request changes nothing: Done means
// the code reached the target branch.

export type SyncedStory = UserStory & { pullRequestUrl: string }

export type PullRequestSyncOutcome = "merged" | "closed"

export type PullRequestSyncEffects = {
  /** The merged story's runtime cleanup: agent, setup, preview, worktree. */
  cleanupMergedStory: (story: UserStory) => Promise<void>
  updateStory: (
    story: UserStory,
    input: UserStoryUpdate,
    options: { cleanup: false }
  ) => Promise<UserStory>
}

/** A story whose pull request GitHub is asked about. */
export function isSyncedStory(story: UserStory): story is SyncedStory {
  return story.status === "in-review" && Boolean(story.pullRequestUrl)
}

/**
 * Applies what GitHub says to the story. Nothing is merged locally: the code
 * is already in the target branch. Returns undefined when the story stays as
 * it is.
 */
export async function applyPullRequestState(
  story: SyncedStory,
  state: PullRequestState,
  effects: PullRequestSyncEffects
): Promise<PullRequestSyncOutcome | undefined> {
  if (state.status === "merged") {
    await effects.updateStory(
      story,
      {
        ...inactiveStoryFields(),
        agentLastError: null,
        agentLastEvent: "Pull request merged on GitHub.",
        mergedAt: state.mergedAt,
        status: "done",
      },
      { cleanup: false }
    )
    await effects.cleanupMergedStory(story)
    return "merged"
  }
  if (state.status === "closed") {
    await effects.updateStory(
      story,
      {
        agentLastError: null,
        agentLastEvent: "Pull request closed without merging.",
        pullRequestUrl: null,
      },
      { cleanup: false }
    )
    return "closed"
  }
  return undefined
}
