import * as React from "react"

import { isBoolean, readUiMemory, writeUiMemory } from "@/lib/ui-memory"

// Whether a story's preview starts without anyone asking, chosen in Settings
// and kept on this machine. Off by default. The backlog and Settings stay
// mounted together, so a change is announced to every reader at once (and to
// the other windows through the storage event).
export const storyPreviewAutoStartKey = "story-preview-auto-start"
const changeEvent = "blame:story-preview-auto-start"

export function readStoryPreviewAutoStart(): boolean {
  return readUiMemory(storyPreviewAutoStartKey, isBoolean) ?? false
}

export function rememberStoryPreviewAutoStart(enabled: boolean) {
  writeUiMemory(storyPreviewAutoStartKey, enabled)
  window.dispatchEvent(new Event(changeEvent))
}

function subscribe(onChange: () => void) {
  window.addEventListener(changeEvent, onChange)
  window.addEventListener("storage", onChange)
  return () => {
    window.removeEventListener(changeEvent, onChange)
    window.removeEventListener("storage", onChange)
  }
}

export function useStoryPreviewAutoStart() {
  return React.useSyncExternalStore(
    subscribe,
    readStoryPreviewAutoStart,
    () => false
  )
}
