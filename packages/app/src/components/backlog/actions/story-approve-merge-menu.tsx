import * as React from "react"
import type { PullRequestAvailability } from "@blame/agent-runtime"

import {
  type ApproveMergeAction,
  ApproveMergeMenu,
  useApproveMergeTransition,
} from "@/components/backlog/actions/approve-merge-menu"
import type { StoryActionHandler } from "@/components/backlog/actions/story-action-button"
import type { UserStory } from "@/components/backlog/data/backlog-data"
import { useStoryInTransition } from "@/pages/backlog/story-transitions"

// A review card's Approve & Merge with the same menu as the drawer. It spins
// while the story merges or opens a pull request, from the card or the drawer.
export function StoryApproveMergeMenu({
  onAction,
  onCheckPullRequest,
  story,
}: {
  onAction: StoryActionHandler
  onCheckPullRequest?: () => Promise<PullRequestAvailability>
  story: UserStory
}) {
  // Covers the moment before the story is marked as in transition.
  const [pendingAction, setPendingAction] = React.useState<ApproveMergeAction>()
  const transitionAction = useApproveMergeTransition(story.id)
  // Another action (pause, resume, comment) is already running on the story.
  const busy = useStoryInTransition(story.id)

  async function runAction(action: ApproveMergeAction) {
    setPendingAction(action)
    try {
      await onAction(story, action)
    } finally {
      setPendingAction(undefined)
    }
  }

  return (
    // The card is draggable: pressing the button or the arrow, or choosing in
    // the menu (React events cross its portal), must not start a drag.
    <div onPointerDown={(event) => event.stopPropagation()}>
      <ApproveMergeMenu
        activeAction={pendingAction ?? transitionAction}
        compact
        disabled={busy}
        hasPullRequest={Boolean(story.pullRequestUrl)}
        onAction={(action) => void runAction(action)}
        onCheckPullRequest={onCheckPullRequest}
        targetBranch={story.targetBranch}
      />
    </div>
  )
}
