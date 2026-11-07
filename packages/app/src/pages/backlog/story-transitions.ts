import * as React from "react"

// Stories being paused, resumed, sent a comment, started or merged right now.
// A second action on the same story waits for the first to finish (no double
// resume or merge), and automatic recovery leaves these stories alone. The
// store lives outside the backlog page, so the card and the drawer show the
// same state and an action keeps running wherever the person navigates.
export type StoryTransitionKind = "merge" | "other"

const busy = new Set<string>()
const kinds = new Map<string, StoryTransitionKind>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function storiesInTransition(): ReadonlySet<string> {
  return busy
}

// Runs the action unless the story is already in a transition; returns
// undefined when it was skipped.
export async function withStoryTransition<T>(
  storyId: string,
  action: () => Promise<T>,
  kind: StoryTransitionKind = "other"
): Promise<T | undefined> {
  if (busy.has(storyId)) return undefined
  busy.add(storyId)
  kinds.set(storyId, kind)
  emit()
  try {
    return await action()
  } finally {
    busy.delete(storyId)
    kinds.delete(storyId)
    emit()
  }
}

export function useStoryInTransition(storyId: string | undefined) {
  return React.useSyncExternalStore(
    subscribe,
    () => Boolean(storyId && busy.has(storyId)),
    () => false
  )
}

export function useStoryTransitionKind(storyId: string | undefined) {
  return React.useSyncExternalStore(
    subscribe,
    () => (storyId ? kinds.get(storyId) : undefined),
    () => undefined
  )
}

export function storyTransitionKind(storyId: string) {
  return kinds.get(storyId)
}
