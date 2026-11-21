import type { UserStory } from "@/components/backlog/data/backlog-data"
import {
  beginUserStoryPreviewDeletion,
  cancelUserStoryPreviewDeletion,
  clearUserStoryPreviewState,
} from "@/components/backlog/drawer/use-user-story-preview-runner"

// Delete Permanently: the story service stops the story's agent and
// runtime, removes its worktree and deletes it; this window forgets its
// preview's state meanwhile (no preview restarts for a story going away).
export async function deleteUserStory(
  story: UserStory,
  removeStory: (story: UserStory) => Promise<void>
) {
  await beginUserStoryPreviewDeletion(story.id)
  try {
    await removeStory(story)
    clearUserStoryPreviewState(story.id)
  } catch (error) {
    cancelUserStoryPreviewDeletion(story.id)
    throw error
  }
}
