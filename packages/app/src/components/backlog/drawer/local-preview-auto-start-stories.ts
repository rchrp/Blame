// Local container previews that start by themselves once the agent hands a
// story over for review, so the review opens on a running app. The runtime
// VM has limited memory, so only the most recently updated stories qualify.
// A story whose run configuration is none (`null`, the title model's
// choice) starts nothing, as in the cloud.

export const localPreviewAutoStartLimit = 2

type AutoStartCandidate = {
  id: string
  status: string
  workspaceMode?: string | null
  worktree?: string | null
  updatedAt?: string | null
  runConfigurationId?: string | null
}

export function localPreviewAutoStartStories<Story extends AutoStartCandidate>(
  stories: Story[],
  limit = localPreviewAutoStartLimit
) {
  return stories
    .filter(
      (story) =>
        story.status === "in-review" &&
        story.workspaceMode === "local-container" &&
        Boolean(story.worktree) &&
        story.runConfigurationId !== null
    )
    .sort(
      (left, right) =>
        (Date.parse(right.updatedAt ?? "") || 0) -
        (Date.parse(left.updatedAt ?? "") || 0)
    )
    .slice(0, limit)
}
