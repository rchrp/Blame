import * as React from "react"

import {
  effectiveContextLimit,
  modelInputLimit,
} from "@/components/model/context-limits"

// The context cap a story's next turns use, when the person picked one.
// Unset means the provider's own limit. Kept per story in local storage.

const storageKey = "blame.story-context-limit.v1"
const listeners = new Set<() => void>()
let limits: Record<string, number> = readLimits()

function readLimits(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(
      globalThis.localStorage?.getItem(storageKey) ?? "{}"
    )
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && entry[1] > 0
      )
    )
  } catch {
    return {}
  }
}

export function storyContextLimit(storyId: string | undefined) {
  return storyId ? limits[storyId] : undefined
}

export function saveStoryContextLimit(
  storyId: string,
  limit: number | undefined
) {
  const next = { ...limits }
  if (limit) next[storyId] = limit
  else delete next[storyId]
  limits = next
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(limits))
  } catch {
    // Still used while the app stays open.
  }
  for (const listener of listeners) listener()
}

export function useStoryContextLimit(storyId: string | undefined) {
  const saved = React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => limits,
    () => limits
  )
  return storyId ? saved[storyId] : undefined
}

// What a story's next session receives: its cap, never above the model.
export function storyMaxInputTokens(
  storyId: string,
  model: Parameters<typeof modelInputLimit>[0],
  providers: Parameters<typeof modelInputLimit>[1]
) {
  return effectiveContextLimit(
    storyContextLimit(storyId),
    modelInputLimit(model, providers)
  )
}
