import type {
  BacklogColumnId,
  UserStory,
} from "@/components/backlog/data/backlog-data"
import type {
  DrawerAction,
  UserStoryDevelopmentTab,
  UserStoryDrawerMode,
} from "@/components/backlog/shared/backlog-types"

export function activityItems(status: BacklogColumnId) {
  const items: string[] = []
  if (status === "in-progress" || status === "in-review" || status === "done") {
    items.push("Agent created a dedicated worktree.")
  }
  if (status === "in-review" || status === "done")
    items.push("Agent submitted work for review.")
  if (status === "done") items.push("Approved and merged into the main branch.")
  if (status === "discarded")
    items.push("User story was rejected or cancelled.")
  return items
}

export function commentButtonLabel(status: BacklogColumnId) {
  if (status === "in-progress") return "Pause & Give Feedback"
  if (status === "in-review") return "Request Changes"
  if (status === "done") return "Comment"
  return "Comment"
}

export function drawerActions(
  mode: UserStoryDrawerMode,
  status: BacklogColumnId
): DrawerAction[] {
  if (mode === "create") return ["Discard", "Save as Draft", "Send to Dev Agent"]
  if (status === "backlog")
    return ["Discard", "Save Changes", "Send to Dev Agent"]
  if (status === "ready") return ["Dequeue"]
  if (status === "in-progress") return ["Stop Agent"]
  if (status === "in-review")
    return ["Reject", "Approve & Merge"]
  if (status === "done") return ["Close"]
  return ["Delete Permanently", "Rework as Draft"]
}

export function hasDevelopmentTab(status: BacklogColumnId) {
  return (
    status === "backlog" ||
    status === "ready" ||
    status === "in-progress" ||
    status === "in-review" ||
    status === "done"
  )
}

export function hasConversation(userStory: UserStory | undefined) {
  return Boolean(userStory?.comments?.length || userStory?.agentRuns?.length)
}

export function isEditable(
  mode: UserStoryDrawerMode,
  status: BacklogColumnId,
  userStory: UserStory | undefined
) {
  return mode === "create" || (status === "backlog" && !hasConversation(userStory))
}

export function normalizeDevelopmentTab(
  status: BacklogColumnId,
  tab: UserStoryDevelopmentTab
) {
  if (status === "backlog" || status === "ready") return "files"
  if (status === "done") return "diff"
  return tab
}
