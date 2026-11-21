import type { UserStory } from "../../components/backlog/data/backlog-data.ts"

export function activePreviewStory(story: UserStory) {
  return (
    (story.status === "in-progress" || story.status === "in-review") &&
    Boolean(story.worktree) &&
    Boolean(story.previewUrl || story.runConfigurationId)
  )
}

// Recovery restarts a story's preview that went down. While the window is
// hidden only the agents at work use previews: only theirs are kept up,
// the others recover once the window shows again.
export function previewRecoveryStories(stories: UserStory[], hidden: boolean) {
  return stories.filter(
    (story) =>
      activePreviewStory(story) && (!hidden || story.agentStatus === "Running")
  )
}

// What preview recovery looks at: it runs again when this changes.
export function previewRecoveryStateKey(stories: UserStory[]) {
  return stories
    .filter(activePreviewStory)
    .map((story) =>
      [
        story.id,
        story.status,
        story.worktree,
        story.workspaceMode,
        story.previewUrl,
        story.runConfigurationId,
      ].join("\0")
    )
    .sort()
    .join("\n")
}
