import type { ProjectPreviewRuntimeState } from "@blame/agent-runtime"

// Each read of a local preview's state asks Blame Runtime for its files
// and containers. The desktop tells the app when it changes the state
// itself; polls catch what only Docker sees, often while the preview
// changes, rarely once it settled, never in a hidden window. The desktop
// also counts each read from a visible window as use of the preview,
// which keeps it awake and wakes it if it hibernates.
export const previewRuntimeChangingPollMs = 2_000
export const previewRuntimeSettledPollMs = 10_000

/** The delay before the next read, none while the window is hidden. */
export function previewRuntimePollDelay(input: {
  hidden: boolean
  runtime: ProjectPreviewRuntimeState | undefined
}) {
  if (input.hidden) return undefined
  return previewRuntimeSettled(input.runtime)
    ? previewRuntimeSettledPollMs
    : previewRuntimeChangingPollMs
}

/** Whether the desktop's change concerns the worktree the app shows. */
export function samePreviewWorktree(changed: string, shown: string) {
  const normalized = (path: string) =>
    path.replaceAll("\\", "/").replace(/\/+$/, "")
  return normalized(changed) === normalized(shown)
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
