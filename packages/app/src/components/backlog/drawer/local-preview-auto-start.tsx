import * as React from "react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { isPreviewAutoStartDisabled } from "@/components/backlog/drawer/use-user-story-preview-runner"
import { usePlatform } from "@/context/platform"

// Starts a local container story preview in the background once the story
// reaches review. A preview the user stopped, one already running or
// starting, and one that failed are left alone; a failure stays explained in
// the preview pane rather than in a toast nobody asked for.

const startedPreviews = new Set<string>()

export function LocalPreviewAutoStart({ story }: { story: UserStory }) {
  const workspace = usePlatform().workspace
  const worktree = story.worktree
  React.useEffect(() => {
    const readState = workspace?.projectPreviewRuntimeState
    const control = workspace?.controlProjectPreview
    if (!worktree || !readState || !control) return
    if (isPreviewAutoStartDisabled(story.id)) return
    const key = `${story.id}:${worktree}`
    if (startedPreviews.has(key)) return
    let cancelled = false
    void (async () => {
      const state = await readState({
        worktree,
        workspaceMode: "local-container",
      })
      if (cancelled || startedPreviews.has(key)) return
      // A suspended preview was started once and left unused: it starts
      // again when opened.
      if (
        state.desiredStatus === "running" ||
        state.lifecycle?.status === "pending" ||
        state.lifecycle?.status === "error" ||
        state.lifecycle?.phase === "suspended"
      )
        return
      const configurationId =
        story.runConfigurationId ??
        state.selectedConfigurationId ??
        state.configurations.find((configuration) => configuration.default)?.id
      if (!configurationId) return
      startedPreviews.add(key)
      await control({
        action: "start",
        configurationId,
        worktree,
      })
    })().catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [story.id, story.runConfigurationId, workspace, worktree])
  return null
}
