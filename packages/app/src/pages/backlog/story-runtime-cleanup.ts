import { toast } from "sonner"

import type {
  BacklogColumnId,
  UserStory,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import {
  beginUserStoryPreviewDeletion,
  cancelUserStoryPreviewDeletion,
  clearUserStoryPreviewState,
  stopManagedCloudPreview,
} from "@/components/backlog/drawer/use-user-story-preview-runner"
import type { Platform, usePlatform } from "@/context/platform"
import { inactiveStoryFields } from "./story-runtime-state"

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

export async function inactiveStoryCleanup(
  story: UserStory,
  input: UserStoryUpdate,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string | undefined
): Promise<UserStoryUpdate> {
  const nextStatus = input.status ?? story.status
  if (!leavesRuntimeStatus(story.status, nextStatus)) return {}
  await stopStoryRuntime(story, platform)
  await removeStoryWorktree(story, platform, repositoryRoot)
  return inactiveStoryFields()
}

export function asyncInactiveStoryCleanup(
  story: UserStory,
  input: UserStoryUpdate
) {
  const nextStatus = input.status ?? story.status
  return (
    nextStatus === "discarded" && leavesRuntimeStatus(story.status, nextStatus)
  )
}

export async function cleanupInactiveStory(
  story: UserStory,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string | undefined,
  backlog: ReturnType<typeof useBacklogStore>
) {
  backlog.setStoryCleanup(story, true)
  try {
    await stopStoryRuntime(story, platform)
    await removeStoryWorktree(story, platform, repositoryRoot)
    await backlog.update(story, inactiveStoryFields())
  } catch (error) {
    toast.error("Discarded story cleanup failed", {
      description: errorMessage(error),
      position: "bottom-right",
    })
  } finally {
    backlog.setStoryCleanup(story, false)
  }
}

const runtimeStatuses = new Set<BacklogColumnId>(["in-progress", "in-review"])

function leavesRuntimeStatus(
  currentStatus: BacklogColumnId,
  nextStatus: BacklogColumnId
) {
  return runtimeStatuses.has(currentStatus) && !runtimeStatuses.has(nextStatus)
}

async function stopStoryRuntime(
  story: UserStory,
  platform: ReturnType<typeof usePlatform>
) {
  await Promise.all([
    abortStoryAgent(story, platform),
    stopStoryProjectSetup(story, platform),
    stopManagedCloudPreview(platform, story.id),
    platform.previewDevices?.stop({ storyId: story.id, destroy: true }),
  ])
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
