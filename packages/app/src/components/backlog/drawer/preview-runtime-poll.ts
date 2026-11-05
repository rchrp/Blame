import type { ProjectPreviewRuntimeState } from "@blame/agent-runtime"

// Each read of a local preview's state runs a few dozen commands in Blame
// Runtime. Read it often while it changes, rarely once it has settled. The
// desktop also counts each read from a visible window as use of the preview,
// which keeps it from being suspended after 20 idle minutes.
export const previewRuntimeChangingPollMs = 2_000
export const previewRuntimeSettledPollMs = 10_000
export const previewRuntimeHiddenPollMs = 60_000

export function previewRuntimePollDelay(input: {
  hidden: boolean
  quickUntil: number
  now: number
  runtime: ProjectPreviewRuntimeState | undefined
}) {
  if (input.hidden) return previewRuntimeHiddenPollMs
  if (input.now < input.quickUntil) return previewRuntimeChangingPollMs
  return previewRuntimeSettled(input.runtime)
    ? previewRuntimeSettledPollMs
    : previewRuntimeChangingPollMs
}

// Starting, stopping or not read yet: the next read may differ.
export function previewRuntimeSettled(
  runtime: ProjectPreviewRuntimeState | undefined
) {
  if (!runtime?.configurations.length) return false
  if (runtime.lifecycle?.status === "pending") return false
  return !Object.values(runtime.statuses).includes("starting")
}

// The desktop answers with a new object each time: keep the current one when
// nothing changed, so the drawer does not render again for nothing.
export function samePreviewRuntimeState(
  current: ProjectPreviewRuntimeState | undefined,
  next: ProjectPreviewRuntimeState | undefined
) {
  return (
    current === next ||
    (current !== undefined &&
      next !== undefined &&
      JSON.stringify(current) === JSON.stringify(next))
  )
}
