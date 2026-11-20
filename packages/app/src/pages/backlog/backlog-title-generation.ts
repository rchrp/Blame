import type { ProjectRunConfiguration } from "@blame/agent-runtime"

import type {
  UserStory,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"

import type { useModelSelection } from "@/components/model/model-selection"

import type { useCloudAuth } from "@/context/cloud-auth"

import type { usePlatform } from "@/context/platform"

import {
  engineModelChoice,
  generateAgentTitleSelection,
} from "@/lib/agent-title-generation"

const untitledUserStoryTitle = "Untitled user story"

type QueuedUserStoryTitleRequest = {
  story: UserStory
  auth: ReturnType<typeof useCloudAuth>
  platform: ReturnType<typeof usePlatform>
  projectPath?: string
  model: ReturnType<typeof useModelSelection>["currentModel"]
  reasoningEffort: ReturnType<typeof useModelSelection>["currentVariant"]
  runConfigurations: ProjectRunConfiguration[]
  updateStory: (
    story: UserStory,
    input: UserStoryUpdate,
    options?: { cleanup?: boolean }
  ) => Promise<UserStory>
}

export function queuedUserStoryTitleRequest(
  request: QueuedUserStoryTitleRequest
) {
  if (!queuedStoryNeedsGeneratedTitle(request)) return undefined
  if (queuedStoryTitleGenerationBlocked(request)) return undefined
  return request
}

function queuedStoryTitleGenerationBlocked(
  request: QueuedUserStoryTitleRequest
) {
  return (
    !request.story.summary.trim() ||
    !request.projectPath ||
    request.auth.status !== "authenticated" ||
    !request.model ||
    !request.platform.engine
  )
}

// Marks the story while its title is generated. A failed generation leaves
// the story as it is.
export async function runQueuedStoryTitleGeneration(
  request: QueuedUserStoryTitleRequest,
  setGenerating: (generating: boolean) => void
) {
  setGenerating(true)
  try {
    const title = await generatedQueuedStoryTitle(request)
    return await persistGeneratedQueuedStoryTitle(request, title)
  } catch {
    return undefined
  } finally {
    setGenerating(false)
  }
}

async function generatedQueuedStoryTitle(request: QueuedUserStoryTitleRequest) {
  return generateAgentTitleSelection(
    request.platform.engine!,
    queuedStoryTitleGenerationInput(request)
  )
}

async function persistGeneratedQueuedStoryTitle(
  request: QueuedUserStoryTitleRequest,
  generated: { title: string; runConfigurationId?: string | null }
) {
  return request.updateStory(
    request.story,
    {
      title: missingUserStoryTitle(request.story.title)
        ? generated.title
        : request.story.title,
      runConfigurationId: generated.runConfigurationId ?? null,
    },
    { cleanup: false }
  )
}

function queuedStoryTitleGenerationInput(request: QueuedUserStoryTitleRequest) {
  return {
    context: "user-story" as const,
    model: engineModelChoice({
      currentModel: request.model,
      currentVariant: request.reasoningEffort,
    })!,
    projectId: request.story.projectId,
    prompt: request.story.summary,
    runConfigurations: request.runConfigurations,
    workspace: request.projectPath!,
  }
}

function queuedStoryNeedsGeneratedTitle(request: QueuedUserStoryTitleRequest) {
  if (request.story.status !== "ready") return false
  if (missingUserStoryTitle(request.story.title)) return true
  if (!request.runConfigurations.length) return false
  return !request.runConfigurations.some(
    ({ id }) => id === request.story.runConfigurationId
  )
}

export function titleGenerationStoryIds(
  current: Set<string>,
  storyId: string,
  generating: boolean
) {
  const next = new Set(current)
  if (generating) next.add(storyId)
  else next.delete(storyId)
  return next.size === current.size &&
    next.has(storyId) === current.has(storyId)
    ? current
    : next
}

function missingUserStoryTitle(title: string) {
  const value = title.trim()
  return !value || value.toLowerCase() === untitledUserStoryTitle.toLowerCase()
}
