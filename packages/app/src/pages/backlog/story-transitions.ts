import * as React from "react"

// Stories being paused, resumed, sent a comment or started right now. A
// second action on the same story waits for the first to finish (no double
// resume), and automatic recovery leaves these stories alone.
const busy = new Set<string>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function storiesInTransition(): ReadonlySet<string> {
  return busy
}

// Runs the action unless the story is already in a transition; returns
// undefined when it was skipped.
export async function withStoryTransition<T>(
  storyId: string,
  action: () => Promise<T>
): Promise<T | undefined> {
  if (busy.has(storyId)) return undefined
  busy.add(storyId)
  emit()
  try {
    return await action()
  } finally {
    busy.delete(storyId)
    emit()
  }
}

export function useStoryInTransition(storyId: string | undefined) {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => Boolean(storyId && busy.has(storyId)),
    () => false
  )
}
