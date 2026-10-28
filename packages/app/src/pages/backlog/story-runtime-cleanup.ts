import type { UserStory } from "@/components/backlog/data/backlog-data"
import {
  beginUserStoryPreviewDeletion,
  cancelUserStoryPreviewDeletion,
  clearUserStoryPreviewState,
} from "@/components/backlog/drawer/use-user-story-preview-runner"
import type { Platform } from "@/context/platform"

export async function deleteUserStoryWithRuntime(
  story: UserStory,
  platform: Platform,
  repositoryRoot: string | undefined,
  removeStory: (story: UserStory) => Promise<void>
) {
  await beginUserStoryPreviewDeletion(story.id)
  try {
    await platform.previewDevices?.stop({ storyId: story.id, destroy: true })
    await abortStoryAgent(story, platform)
    const setupStopped = await stopStoryProjectSetup(story, platform)
    if (story.worktree) {
      await removeStoryWorktree(story, platform, repositoryRoot, setupStopped)
    }
    await removeStory(story)
    clearUserStoryPreviewState(story.id)
  } catch (error) {
    cancelUserStoryPreviewDeletion(story.id)
    throw error
  }
}

export async function abortStoryAgent(story: UserStory, platform: Platform) {
  if (!story.clineSessionId) return
  await platform.agent?.sessions
    .abort(story.clineSessionId)
    .catch(() => undefined)
}

export async function stopStoryProjectSetup(
  story: UserStory,
  platform: Platform
) {
  if (!story.worktree) return false
  return (
    (await platform.workspace
      ?.stopProjectSetup({
        workspaceMode: story.workspaceMode ?? undefined,
        worktree: story.worktree,
      })
      .catch(() => false)) ?? false
  )
}

export async function removeStoryWorktree(
  story: UserStory,
  platform: Platform,
  repositoryRoot: string | undefined,
  projectSetupStopped = false
) {
  if (!story.worktree) return
  if (!repositoryRoot) throw new Error("Unable to resolve repository root.")
  const removed = await platform.workspace?.removeWorktree({
    projectSetupStopped,
    repositoryRoot,
    workspaceMode: story.workspaceMode ?? undefined,
    worktree: story.worktree,
  })
  if (!removed) throw new Error("Unable to remove worktree.")
}
