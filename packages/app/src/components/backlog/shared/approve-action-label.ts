import type { UserStory } from "@/components/backlog/data/backlog-data"

// What approving a story in review is called when it is not "Approve & Merge":
// a Direct story commits its own files in the project folder, and a story
// with nothing to merge is only marked as done.
export function approveActionLabel(
  story: Pick<UserStory, "workspaceMode"> | undefined,
  reviewDiffEmpty?: boolean
) {
  if (reviewDiffEmpty) return "Mark as Done"
  if (story?.workspaceMode === "direct") return "Approve & Commit"
  return undefined
}
