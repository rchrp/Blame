import * as React from "react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { CloudAiModelPreference } from "@/context/cloud-auth"
import type { ReasoningSelection } from "@blame/agent-runtime"

// The model and reasoning a story's next turn (a comment or a resume) uses.
// It starts as the model of the story's last turn, so a story keeps its model
// until the person picks another one for it; the saved default only applies
// to new stories. Kept per story in local storage.

const storageKey = "blame.story-model-choice.v1"
const listeners = new Set<() => void>()
let choices: Record<string, CloudAiModelPreference> = readChoices()

function readChoices(): Record<string, CloudAiModelPreference> {
  try {
    const value: unknown = JSON.parse(
      globalThis.localStorage?.getItem(storageKey) ?? "{}"
    )
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, CloudAiModelPreference>)
      : {}
  } catch {
    return {}
  }
}

export function saveStoryModelChoice(
  storyId: string,
  preference: CloudAiModelPreference
) {
  choices = { ...choices, [storyId]: preference }
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(choices))
  } catch {
    // Still used while the app stays open.
  }
  for (const listener of listeners) listener()
}

type StoryModelSource = Pick<
  UserStory,
  "agentModelId" | "agentProviderId" | "agentRuns" | "id"
>

export function storyModelChoice(
  story: StoryModelSource,
  saved: Record<string, CloudAiModelPreference> = choices
): CloudAiModelPreference | undefined {
  const chosen = saved[story.id]
  if (chosen) return chosen
  const lastRun = [...(story.agentRuns ?? [])]
    .filter((run) => run.providerId && run.modelId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)
  if (lastRun?.providerId && lastRun.modelId) {
    return {
      credentialLabel: null,
      modelId: lastRun.modelId,
      providerId: lastRun.providerId,
      reasoningEffort: (lastRun.reasoningEffort as ReasoningSelection) ?? null,
    }
  }
  if (story.agentProviderId && story.agentModelId) {
    return {
      credentialLabel: null,
      modelId: story.agentModelId,
      providerId: story.agentProviderId,
      reasoningEffort: null,
    }
  }
  return undefined
}

export function useStoryModelChoice(story: StoryModelSource | undefined) {
  const saved = React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => choices,
    () => choices
  )
  return story ? storyModelChoice(story, saved) : undefined
}
