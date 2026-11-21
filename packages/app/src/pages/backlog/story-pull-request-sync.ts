import type { PullRequestState } from "@blame/agent-runtime"

import type { UserStory } from "@/components/backlog/data/backlog-data"

// A story in review whose pull request is open on GitHub follows what
// happens to it there: merged is Done, closed without merge gives back Reject
// and Approve & Merge. An approved pull request changes nothing: Done means
// the code reached the target branch.

export type SyncedStory = UserStory & { pullRequestUrl: string }

export type PullRequestSyncOutcome = "merged" | "closed"

export type PullRequestSyncEffects = {
  /** Done, with its runtime cleaned up: agent, setup, preview, worktree (the story service). */
  completeStory: (story: UserStory, mergedAt: string) => Promise<unknown>
  /** The pull request's link goes, with the error it may have left. */
  forgetPullRequest: (story: UserStory) => Promise<unknown>
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
    await effects.completeStory(story, state.mergedAt)
    return "merged"
  }
  if (state.status === "closed") {
    await effects.forgetPullRequest(story)
    return "closed"
  }
  return undefined
}
