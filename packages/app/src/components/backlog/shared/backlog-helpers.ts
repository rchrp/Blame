import {
  type BacklogAction,
  type UserStory,
} from "@/components/backlog/data/backlog-data"
import type {
  DrawerTarget,
  UserStoryDevelopmentTab,
} from "@/components/backlog/shared/backlog-types"

export function storyStatus(story: UserStory) {
  if (story.status === "backlog") return "Draft"
  if (story.status === "ready") return "Queued"
  if (story.agentStatus) return story.agentStatus
  if (story.status === "in-review") return "Review"
  if (story.status === "done") return "Merged"
  if (story.status === "discarded") return "Rejected"
  return undefined
}

export function storyDetail(story: UserStory) {
  if (story.mergeCommit)
    return `Merged ${story.mergedAt} · ${story.mergeCommit}`
  if (story.discardedReason) return story.discardedReason
  return undefined
}

export function drawerTargetForAction(
  story: UserStory,
  action: BacklogAction
): DrawerTarget {
  if (action === "Open Preview")
    return {
      userStory: story,
      mode: "view",
      initialTab: "preview",
    }
  if (action === "View Files") return developmentTarget(story, "files")
  if (action === "View Diff") return developmentTarget(story, "diff")
  if (action === "View Terminal") return developmentTarget(story, "terminal")
  return {
    userStory: story,
    mode:
      story.status === "backlog" || story.status === "discarded"
        ? "edit"
        : "view",
    initialTab: "user-story",
  }
}

function developmentTarget(
  story: UserStory,
  initialDevelopmentTab: UserStoryDevelopmentTab
): DrawerTarget {
  return {
    userStory: story,
    mode: "view",
    initialTab: "development",
    initialDevelopmentTab,
  }
}
