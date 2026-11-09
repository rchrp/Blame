import * as React from "react"
import { toast } from "sonner"

import type {
  UserStory,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import type { useModelSelection } from "@/components/model/model-selection"
import type { useCloudAuth } from "@/context/cloud-auth"
import type { useGitIdentity } from "@/context/git-identity"
import type { usePlatform } from "@/context/platform"
import type { useProjects } from "@/context/projects"
import { measurePerformanceOperation } from "@/lib/performance-diagnostics"
import { projectCodePractices } from "@/lib/project-code-practices"
import { approveAndMergeValidationError } from "./story-post-merge"
import { activeStory } from "./story-runtime-state"
import { withStoryTransition } from "./story-transitions"

type StoryPullRequestInput = {
  alternativeSelection: ReturnType<typeof useModelSelection>
  auth: ReturnType<typeof useCloudAuth>
  backlog: ReturnType<typeof useBacklogStore>
  gitIdentity: ReturnType<typeof useGitIdentity>
  platform: ReturnType<typeof usePlatform>
  projects: ReturnType<typeof useProjects>
  storiesRef: { current: UserStory[] }
  updateStory: (story: UserStory, input: UserStoryUpdate) => Promise<UserStory>
}

// Open PR: the host commits, pushes the story branch and runs gh. The story
// stays in review; its pull request URL is kept and opened in the browser.
export function useStoryPullRequest({
  alternativeSelection,
  auth,
  backlog,
  gitIdentity,
  platform,
  projects,
  storiesRef,
  updateStory,
}: StoryPullRequestInput) {
  const openStoryPullRequest = React.useCallback(
    async (story: UserStory) => {
      const validationError = approveAndMergeValidationError(
        story,
        auth,
        platform,
        projects.activeProject?.path,
        alternativeSelection.currentModel
      )
      if (validationError) {
        toast.error("Unable to open a pull request", {
          description: validationError,
          position: "bottom-right",
        })
        return story
      }
      try {
        const [currentStory, codePractices] = await Promise.all([
          detailedStory(activeStory(story, storiesRef.current), backlog),
          projectCodePractices(auth, projects),
        ])
        const result = await measurePerformanceOperation(
          "agent.transition.open_pull_request",
          () =>
            platform.agent!.openPullRequest({
              apiConnection: auth.apiConnection,
              executionId: crypto.randomUUID(),
              providerId: alternativeSelection.currentModel!.provider.id,
              modelId: alternativeSelection.currentModel!.id,
              credentialLabel:
                alternativeSelection.currentModel!.credentialLabel,
              reasoningEffort: alternativeSelection.currentVariant,
              repositoryRoot: projects.activeProject!.path,
              worktree: currentStory.worktree!,
              storyBranch: currentStory.branch!,
              targetBranch: currentStory.targetBranch ?? undefined,
              title: currentStory.title,
              summary: currentStory.summary,
              agentSummary: currentStory.agentFinalResponse ?? undefined,
              storyId: currentStory.id,
              codePractices,
            })
        )
        platform.openExternalLink?.(result.url)
        toast.success(
          result.created ? "Pull request opened" : "Pull request updated",
          {
            description: result.created
              ? `Into ${result.targetBranch}: ${result.url}`
              : `Latest work pushed to ${result.url}`,
            position: "bottom-right",
          }
        )
        return await updateStory(currentStory, {
          agentLastError: null,
          agentLastEvent: result.created
            ? `Pull request opened: ${result.url}`
            : `Pushed to pull request ${result.url}`,
          pullRequestUrl: result.url,
        })
      } catch (error) {
        const message = errorMessage(error)
        const askedIdentity = gitIdentity?.handleError(message, () =>
          toast.success("Git name and email saved", {
            description: "Open PR again to open the pull request.",
            position: "bottom-right",
          })
        )
        if (!askedIdentity)
          toast.error("Open PR failed", {
            description: message,
            position: "bottom-right",
          })
        return activeStory(story, storiesRef.current)
      }
    },
    [
      auth,
      backlog,
      gitIdentity,
      platform,
      projects,
      alternativeSelection.currentModel,
      alternativeSelection.currentVariant,
      storiesRef,
      updateStory,
    ]
  )
  const openPullRequestForStory = React.useCallback(
    async (story: UserStory) =>
      (await withStoryTransition(
        story.id,
        () => openStoryPullRequest(story),
        "pull-request"
      )) ?? activeStory(story, storiesRef.current),
    [openStoryPullRequest, storiesRef]
  )
  const checkPullRequest = React.useCallback(async () => {
    const repositoryRoot = projects.activeProject?.path
    if (!platform.agent || !repositoryRoot)
      return { status: "not-github" } as const
    return platform.agent.pullRequestAvailability({ repositoryRoot })
  }, [platform.agent, projects.activeProject?.path])

  return { checkPullRequest, openPullRequestForStory }
}

function detailedStory(
  story: UserStory,
  backlog: ReturnType<typeof useBacklogStore>
) {
  if (backlog.storyDetailsLoaded(story)) return Promise.resolve(story)
  return backlog.loadDetail(story)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
