// Whether a story's preview starts without anyone asking. The person turns
// that on in Settings; it is off by default. Direct stories have no managed
// preview, so nothing starts for them either way. A story whose run
// configuration is none (`null`, the title model's choice) starts nothing.
type StoryPreviewMode = {
  workspaceMode?: string | null
}

function hasManagedPreview({ workspaceMode }: StoryPreviewMode) {
  return workspaceMode === "local-container" || workspaceMode === "cloud-mirror"
}

/** Whether this story's preview may start by itself: setting on, managed preview, a service to run. */
export function storyPreviewStartsAutomatically(
  story: StoryPreviewMode & { runConfigurationId?: string | null },
  autoStartEnabled: boolean
) {
  return (
    autoStartEnabled &&
    hasManagedPreview(story) &&
    story.runConfigurationId !== null
  )
}

/**
 * Whether the "not started" state tells that previews no longer start on
 * their own: only where they would with the setting on. The project's own
 * app (`projectRunMode`) is never started by it.
 */
export function autoStartTipVisible(input: {
  autoStartEnabled: boolean
  projectRunMode: boolean
  workspaceMode?: string | null
}) {
  return (
    !input.autoStartEnabled && !input.projectRunMode && hasManagedPreview(input)
  )
}
