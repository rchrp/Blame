import { toast } from "sonner"
import type { ApproveAndMergeResult } from "@blame/agent-runtime"
import type { StoryMergeOutcome } from "@blame/agent-runtime/engine-protocol"

import { afterRendererPaint } from "@/components/backlog/data/agent-transition-scheduling"
import type { useModelSelection } from "@/components/model/model-selection"
import { inviteToStarAfter } from "@/components/star-invite/star-invite"
import type { useCloudAuth } from "@/context/cloud-auth"
import type { usePlatform } from "@/context/platform"
import { celebrateStory } from "@/lib/celebrate"
import { measurePerformanceOperation } from "@/lib/performance-diagnostics"
import { syncPreviewEnvironment } from "./preview-environment-sync"
import { parseProjectPreviewRepairCandidate } from "./project-initialization-database"

// What the window does once the story service merged a story: say where it
// went, celebrate, then check the project's preview environment against the
// merged commits, with the story's own repair if it made one. The story
// service cleans the story's runtime meanwhile.
export async function afterStoryMerged(
  storyId: string,
  projectId: string,
  outcome: StoryMergeOutcome,
  input: {
    auth: ReturnType<typeof useCloudAuth>
    platform: ReturnType<typeof usePlatform>
    model: NonNullable<ReturnType<typeof useModelSelection>["currentModel"]>
    reasoningEffort: ReturnType<typeof useModelSelection>["currentVariant"]
  }
) {
  notifyMerged(outcome.merge, input.platform, outcome.repositoryRoot)
  celebrateStory(storyId)
  inviteToStarAfter("merged")
  await afterRendererPaint()
  await measurePerformanceOperation(
    "agent.transition.initialization_impact",
    () =>
      syncPreviewEnvironment({
        apiConnection: input.auth.apiConnection,
        platform: input.platform,
        projectId,
        repositoryRoot: outcome.repositoryRoot,
        providerId: input.model.provider.id,
        modelId: input.model.id,
        credentialLabel: input.model.credentialLabel,
        reasoningEffort: input.reasoningEffort,
        fallbackBase: outcome.merge.baseCommit,
        previewRepairCandidate:
          outcome.previewRepairCandidate === undefined
            ? undefined
            : parseProjectPreviewRepairCandidate(
                JSON.stringify(outcome.previewRepairCandidate)
              ),
      })
  )
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
      description: error instanceof Error ? error.message : String(error),
      position: "bottom-right",
    })
  }
}
