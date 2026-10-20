import type {
  BacklogColumnId,
  UserStory,
} from "@/components/backlog/data/backlog-data"
import type { BacklogStatusPipRequest } from "@/context/platform"

// Dragging a story onto a column runs one of the actions its card already
// offers. Each action that moves the story to a column becomes a drop zone
// in that column; columns with no action for the story stay out of reach.

export type StoryDropAction = {
  column: BacklogColumnId
  // Asks before running: the action throws work away.
  confirm?: { description: string; title: string }
  id: string
  label: string
  // The same request the card buttons and the status window send.
  request: Omit<BacklogStatusPipRequest, "storyId">
}

export function storyDropActions(
  story: Pick<UserStory, "agentStatus" | "id" | "status" | "workspaceMode">,
  options: { reviewDiffEmpty?: boolean } = {}
): StoryDropAction[] {
  const action = (
    column: BacklogColumnId,
    label: string,
    request: StoryDropAction["request"],
    confirm?: StoryDropAction["confirm"]
  ): StoryDropAction => ({
    column,
    ...(confirm ? { confirm } : {}),
    id: `${story.id}:${column}:${label}`,
    label,
    request,
  })
  switch (story.status) {
    case "backlog":
      return [
        action("ready", "Send to Dev Agent", { action: "Send to Dev Agent" }),
        action("discarded", "Discard", { action: "Discard" }),
      ]
    case "ready":
      return [action("backlog", "Dequeue", { action: "Dequeue" })]
    case "in-progress":
      return [
        action("backlog", "Stop and move to backlog", { stopChoice: "backlog" }),
        action(
          "discarded",
          "Stop and discard",
          { stopChoice: "discard-worktree" },
          {
            description:
              "The agent stops and the story's worktree is deleted with its changes.",
            title: "Stop the agent and discard its work?",
          }
        ),
      ]
    case "in-review":
      return [
        action("in-progress", "Request Changes", {
          drawer: { focusComment: true, initialTab: "user-story" },
        }),
        action(
          "done",
          options.reviewDiffEmpty
            ? "Mark as Done"
            : story.workspaceMode === "direct"
              ? "Approve"
              : "Approve & Merge",
          { action: "Approve & Merge" }
        ),
        options.reviewDiffEmpty
          ? action("discarded", "Discard", { action: "Discard" })
          : action(
              "discarded",
              "Reject and discard",
              { rejectChoice: "discard" },
              {
                description:
                  "The story is rejected and its worktree is deleted with its changes.",
                title: "Reject and discard this work?",
              }
            ),
      ]
    case "done":
      return [
        action("backlog", "New story with this context", {
          action: "Use Context",
        }),
      ]
    case "discarded":
      return [action("backlog", "Rework", { action: "Rework" })]
    default:
      return []
  }
}
