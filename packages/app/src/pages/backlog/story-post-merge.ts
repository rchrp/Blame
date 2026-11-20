import { toast } from "sonner"
import type { ApproveAndMergeResult } from "@blame/agent-runtime"

import { afterRendererPaint } from "@/components/backlog/data/agent-transition-scheduling"
import type {
  UserStory,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import { stopManagedCloudPreview } from "@/components/backlog/drawer/use-user-story-preview-runner"
import type { useModelSelection } from "@/components/model/model-selection"
import { inviteToStarAfter } from "@/components/star-invite/star-invite"
import type { useCloudAuth } from "@/context/cloud-auth"
import type { usePlatform } from "@/context/platform"
import type { useProjects } from "@/context/projects"
import { engineModelChoice } from "@/lib/agent-title-generation"
import { celebrateStory } from "@/lib/celebrate"
import { measurePerformanceOperation } from "@/lib/performance-diagnostics"
import { projectCodePractices } from "@/lib/project-code-practices"
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
import { inactiveStoryFields } from "./story-runtime-state"

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
  if (!platform.engine) return "Blame's agent engine is not available."
}

type ApprovedStoryMerge = {
  auth: ReturnType<typeof useCloudAuth>
  model: NonNullable<ReturnType<typeof useModelSelection>["currentModel"]>
  platform: ReturnType<typeof usePlatform>
  projects: ReturnType<typeof useProjects>
  push?: boolean
  reasoningEffort: ReturnType<typeof useModelSelection>["currentVariant"]
  // The story as Approve & Merge started it.
  runningStory: UserStory
  story: UserStory
  updateStory: (
    story: UserStory,
    input: UserStoryUpdate,
    options: { cleanup?: boolean }
  ) => Promise<UserStory>
}

// Merges a story that passed approveAndMergeValidationError, then cleans its
// runtime in the background. Returns the merged story.
export async function mergeStoryIntoTarget(input: ApprovedStoryMerge) {
  const { auth, model, platform, projects, runningStory, story } = input
  const repositoryRoot = projects.activeProject!.path
  const codePractices = await projectCodePractices(auth, projects)
  const result = await measurePerformanceOperation(
    "agent.transition.approve_merge",
    () =>
      platform.engine!.call("approveAndMerge", {
        model: engineModelChoice({
          currentModel: model,
          currentVariant: input.reasoningEffort,
        })!,
        projectId: projects.activeProject!.id,
        repositoryRoot,
        worktree: story.worktree!,
        storyBranch: story.branch!,
        targetBranch: story.targetBranch ?? undefined,
        push: input.push,
        title: story.title,
        summary: story.summary,
        codePractices,
      })
  )
  notifyMerged(result, platform, repositoryRoot)
  celebrateStory(story.id)
  inviteToStarAfter("merged")
  const mergedStory = await input.updateStory(
    runningStory,
    {
      ...inactiveStoryFields(),
      agentLastError: null,
      baseCommit: result.baseCommit,
      mergeCommit: result.mergeCommit,
      mergedAt: new Date().toISOString(),
      status: "done",
    },
    { cleanup: false }
  )
  void runPostMergeTasks(runningStory, platform, repositoryRoot, {
    apiConnection: auth.apiConnection,
    fallbackBase: result.baseCommit,
    modelId: model.id,
    credentialLabel: model.credentialLabel,
    platform,
    projectId: projects.activeProject!.id,
    providerId: model.provider.id,
    reasoningEffort: input.reasoningEffort,
    repositoryRoot,
  })
  return mergedStory
}

// Says where the story went. A target branch without upstream is not pushed:
// it gets the push -u that publishes it instead.
export function notifyMerged(
  result: ApproveAndMergeResult,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string
) {
  const { push, targetBranch } = result
  if (push.status === "pushed") {
    toast.success("Story approved and merged", {
      description: `Merged into ${targetBranch} and pushed to ${push.upstream}.`,
      position: "bottom-right",
    })
    return
  }
  if (push.status === "skipped") {
    toast.success("Story approved and merged", {
      description: `Merged into ${targetBranch} on this computer, not pushed.`,
      position: "bottom-right",
    })
    return
  }
  const { remote } = push
  const publish = platform.workspace?.gitPublishBranch
  if (!remote) {
    toast.success("Story approved and merged", {
      description: `Merged into ${targetBranch}. Not pushed: the project has no Git remote.`,
      position: "bottom-right",
    })
    return
  }
  toast.success("Story approved and merged", {
    action: publish
      ? {
          label: `Push to ${remote}`,
          onClick: () =>
            void publishTargetBranch(
              () => publish({ branch: targetBranch, remote, root: repositoryRoot }),
              targetBranch,
              remote
            ),
        }
      : undefined,
    description: `Merged into ${targetBranch}, not pushed: the branch has no upstream. Publish it with git push -u ${remote} ${targetBranch}.`,
    duration: 30_000,
    position: "bottom-right",
  })
}

async function publishTargetBranch(
  publish: () => Promise<unknown>,
  branch: string,
  remote: string
) {
  try {
    await publish()
    toast.success(`${branch} pushed to ${remote}`, {
      description: `It now tracks ${remote}/${branch}; the next merges push there.`,
      position: "bottom-right",
    })
  } catch (error) {
    toast.error(`Couldn't push ${branch}`, {
      description: errorMessage(error),
      position: "bottom-right",
    })
  }
}

export async function cleanupMergedStory(
  story: UserStory,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string | undefined
) {
  try {
    const [, projectSetupStopped] = await Promise.all([
      measurePerformanceOperation("agent.transition.cleanup.agent_abort", () =>
        abortStoryAgent(story, platform, { remove: true })
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
