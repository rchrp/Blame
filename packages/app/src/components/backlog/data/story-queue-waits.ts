import * as React from "react"
import type {
  StoryDependency,
  StoryWaitReason,
  StoryWaiting,
} from "@blame/agent-runtime/engine-protocol"

// Why each queued story waits, as the story service in the engine host says
// it: its card in Agent Queue reads it.

let waits = new Map<string, StoryWaitReason>()
const listeners = new Set<() => void>()

export function publishStoryWaits(waiting: readonly StoryWaiting[]) {
  const next = new Map(waiting.map((wait) => [wait.storyId, wait.reason]))
  const same =
    next.size === waits.size &&
    [...next].every(
      ([id, reason]) => JSON.stringify(waits.get(id)) === JSON.stringify(reason)
    )
  if (same) return
  waits = next
  for (const listener of listeners) listener()
}

export function useStoryWait(storyId: string) {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => waits.get(storyId),
    () => undefined
  )
}

/** The reason in a few words for its card. */
export function storyWaitText(reason: StoryWaitReason): string {
  switch (reason.kind) {
    case "dependencies":
      return `Starts after ${named(reason.stories)}`
    case "dependency-dropped":
      return `Will not start: ${named(reason.stories)} ${
        reason.stories.length === 1 ? "was" : "were"
      } discarded or deleted`
    case "no-model":
      return "Choose a model to start it"
    case "signed-out":
      return "Sign in to start it"
    case "no-project":
      return "Open its project on this computer to start it"
    case "initialization":
      return "Waits for the project's preview environment"
    case "runtime":
      return "Waits for Blame Runtime"
    case "needs-runtime":
      return "Install or repair Blame Runtime to start it"
    case "cloud-without-premium":
      return "Cloud Preview needs Premium"
    case "host-dependencies":
      return "A tool it needs is missing on this computer"
    case "git-identity":
      return "Git needs your name and email"
    case "error":
      return `Could not start: ${reason.message}`
    case "epic":
      switch (reason.hold) {
        case "paused":
          return "Its epic is paused"
        case "budget":
          return "Its epic's budget is spent"
        case "elsewhere":
          return "Its epic runs on another computer"
        case "direct":
          return "Needs a working preview environment: an epic's story never runs in your project folder"
        case "unknown":
          return "Waits for its epic to be read"
      }
  }
}

/** A story as the waits and the drawer's field name it: its number and title. */
export function storyDependencyName(
  story: Partial<Pick<StoryDependency, "storyNumber" | "title">>
) {
  return story.storyNumber
    ? `US-${String(story.storyNumber).padStart(3, "0")}${
        story.title ? ` ${story.title}` : ""
      }`
    : "a deleted story"
}

function named(stories: readonly StoryDependency[]) {
  const names = stories.map(storyDependencyName)
  return names.length > 2
    ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
    : names.join(" and ")
}
