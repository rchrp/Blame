import * as React from "react"

// Stories whose preview waits for the project's preview environment to be
// checked against the latest commits. Their worktree gets its preview setup
// only after that, so nothing starts a preview from a stale one.

const waiting = new Set<string>()
const listeners = new Set<() => void>()

export function setStoryPreviewWaiting(storyId: string, value: boolean) {
  if (waiting.has(storyId) === value) return
  if (value) waiting.add(storyId)
  else waiting.delete(storyId)
  listeners.forEach((listener) => listener())
}

export function useStoryPreviewWaiting(storyId: string | undefined) {
  return React.useSyncExternalStore(subscribe, () =>
    Boolean(storyId && waiting.has(storyId))
  )
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
