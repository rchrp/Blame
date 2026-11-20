import {
  type UserStory,
  userStoryReadyForAgent,
} from "@/components/backlog/data/backlog-data"
import type { HostDependencyReport, usePlatform } from "@/context/platform"
import type { useRuntimePreference } from "@/lib/runtime-preference"
import type { useCloudAuth } from "@/context/cloud-auth"
import type { useModelSelection } from "@/components/model/model-selection"
import { activePreviewStory } from "./preview-recovery-stories.ts"

export function reportAgentPersistenceError(error: unknown) {
  console.error("Failed to persist agent update.", error)
}

export type HostDependenciesDialogState = {
  checking: boolean
  report: HostDependencyReport
  runtimeProfile: ReturnType<typeof useRuntimePreference>["profile"]
  workspaceMode: "local-container" | "cloud-mirror" | "direct"
  storyId: string
  storyTitle: string
}

export const maxConcurrentDevelopmentStories = 3

export function runningStories(stories: UserStory[]) {
  return stories.filter(
    (story) => story.status === "in-progress" && story.agentStatus !== "Paused"
  ).length
}

export function queuedStories(
  stories: UserStory[],
  startingStoryIds: Set<string>,
  blockedStories: Map<string, number>
) {
  const now = Date.now()
  return stories
    .filter(
      (story) =>
        userStoryReadyForAgent(story) &&
        !startingStoryIds.has(story.id) &&
        !blocked(story.id, blockedStories, now)
    )
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    )
}

function blocked(
  storyId: string,
  blockedStories: Map<string, number>,
  now: number
) {
  const retryAt = blockedStories.get(storyId)
  if (!retryAt) return false
  if (retryAt > now) return true
  blockedStories.delete(storyId)
  return false
}

export function rotationBlocker(
  authStatus: ReturnType<typeof useCloudAuth>["status"],
  platform: ReturnType<typeof usePlatform>,
  model: ReturnType<typeof useModelSelection>["currentModel"]
) {
  if (authStatus !== "authenticated") return "Authentication is required."
  if (!platform.engine) return "Desktop agent engine is not available."
  if (!platform.workspace?.createWorktree)
    return "Desktop worktree runtime is not available."
  if (!platform.workspace.checkHostDependencies)
    return "Desktop host dependency checks are not available."
  if (!platform.workspace.prepareProjectPreview)
    return "Desktop preview preparation is not available."
  if (!model) return "Choose a model before starting queued user stories."
  return undefined
}

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

export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Unable to start queued user story."
}

