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
