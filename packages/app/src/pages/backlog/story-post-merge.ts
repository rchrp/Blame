import { toast } from "sonner"

import { afterRendererPaint } from "@/components/backlog/data/agent-transition-scheduling"
import type { UserStory } from "@/components/backlog/data/backlog-data"
import { stopManagedCloudPreview } from "@/components/backlog/drawer/use-user-story-preview-runner"
import type { useCloudAuth } from "@/context/cloud-auth"
import type { usePlatform } from "@/context/platform"
import { measurePerformanceOperation } from "@/lib/performance-diagnostics"
import {
  type PreviewEnvironmentSyncInput,
  syncPreviewEnvironment,
} from "./preview-environment-sync"
import { parseProjectPreviewRepairCandidate } from "./project-initialization-database"
import {
  abortStoryAgent,
  removeStoryWorktree,
  stopStoryProjectSetup,
} from "./story-runtime-cleanup"

// Approve & Merge: what it needs before it starts, and what runs once the
// story is merged (runtime cleanup, then the preview environment check).
export function approveAndMergeValidationError(
  story: UserStory,
  auth: ReturnType<typeof useCloudAuth>,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string | undefined,
  model: unknown
) {
  if (!story.worktree) return "This user story has no active worktree."
  if (!story.branch) return "This user story has no feature branch."
  if (!repositoryRoot) return "Unable to resolve the active project."
  if (auth.status !== "authenticated")
    return "Reconnect the provider before approving the merge."
  if (!model) return "Select a model before approving the merge."
  if (!platform.agent?.approveAndMerge)
    return "Desktop agent runtime is not available."
}

async function cleanupMergedStory(
  story: UserStory,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string | undefined
) {
  try {
    const [, projectSetupStopped] = await Promise.all([
      measurePerformanceOperation("agent.transition.cleanup.agent_abort", () =>
        abortStoryAgent(story, platform)
      ),
      measurePerformanceOperation("agent.transition.cleanup.runtime_stop", () =>
        stopStoryProjectSetup(story, platform)
      ),
      measurePerformanceOperation(
        "agent.transition.cleanup.cloud_preview_stop",
        () => stopManagedCloudPreview(platform, story.id)
      ),
    ])
    await measurePerformanceOperation(
      "agent.transition.cleanup.worktree_remove",
      () =>
        removeStoryWorktree(
          story,
          platform,
          repositoryRoot,
          projectSetupStopped
        )
    )
  } catch (error) {
    toast.error("Merged story cleanup failed", {
      description: errorMessage(error),
      position: "bottom-right",
    })
  }
}

// The merge moved the project branch: its preview environment is checked
// against the merged commits now, with the story's own repair if it made one.
export async function runPostMergeTasks(
  story: UserStory,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string,
  previewEnvironment: PreviewEnvironmentSyncInput
) {
  const previewRepairCandidate = await storyPreviewRepairCandidate(
    story,
    platform
  )
  await cleanupMergedStory(story, platform, repositoryRoot)
  await afterRendererPaint()
  await measurePerformanceOperation(
    "agent.transition.initialization_impact",
    () =>
      syncPreviewEnvironment({ ...previewEnvironment, previewRepairCandidate })
  )
}

async function storyPreviewRepairCandidate(
  story: UserStory,
  platform: ReturnType<typeof usePlatform>
) {
  if (!story.worktree || !platform.workspace) return undefined
  try {
    const content = await platform.workspace.readFile({
      root: story.worktree,
      path: ".blame/initialization/preview-repair.json",
    })
    return parseProjectPreviewRepairCandidate(content)
  } catch {
    return undefined
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
