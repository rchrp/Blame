import * as React from "react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { useBacklogStore } from "@/components/backlog/data/backlog-store"
import { usePlatform } from "@/context/platform"
import { useStoryRunMode } from "@/lib/runtime-preference"
import { useCloudAuth } from "@/context/cloud-auth"
import {
  previewRecoveryStateKey,
  previewRecoveryStories,
} from "./preview-recovery-stories"
import { useStoryPreviewPreparation } from "./story-preview-preparation"

const previewRecoveryIntervalMs = 30_000

// Keeps the previews of the board's active stories up: a preview that went
// down comes back, and a story's preview gets ready once it started.
export function usePreviewRecovery(
  backlog: ReturnType<typeof useBacklogStore>
) {
  const platform = usePlatform()
  const premium = useCloudAuth().license?.licensed === true
  const runMode = useStoryRunMode(premium)
  const ensureProjectPreviewUrl = platform.workspace?.ensureProjectPreviewUrl
  const recovering = React.useRef(new Set<string>())
  const storiesRef = React.useRef(backlog.stories)
  const recoveryState = previewRecoveryStateKey(backlog.stories)
  useStoryPreviewPreparation(backlog)

  React.useEffect(() => {
    storiesRef.current = backlog.stories
  }, [backlog.stories])

  const persistRecoveredPreviewUrl = React.useCallback(
    async (story: UserStory, previewUrl: string | null) => {
      if (!previewUrl || previewUrl === story.previewUrl) return
      await backlog.update(story, { previewUrl })
    },
    [backlog]
  )

  const recoverActivePreviews = React.useCallback(
    (stories: UserStory[]) => {
      if (!ensureProjectPreviewUrl) return
      const hidden = document.visibilityState === "hidden"
      previewRecoveryStories(stories, hidden).forEach((story) => {
        if (!story.worktree || recovering.current.has(story.id)) return
        recovering.current.add(story.id)
        void ensureProjectPreviewUrl({
          workspaceMode:
            story.workspaceMode ??
            ((story.runMode ?? runMode) === "vercel-compose"
              ? "cloud-mirror"
              : "local-container"),
          worktree: story.worktree,
        })
          .then((previewUrl) => persistRecoveredPreviewUrl(story, previewUrl))
          .catch(() => undefined)
          .finally(() => recovering.current.delete(story.id))
      })
    },
    [ensureProjectPreviewUrl, persistRecoveredPreviewUrl, runMode]
  )

  React.useEffect(() => {
    if (!ensureProjectPreviewUrl || backlog.loading) return
    recoverActivePreviews(storiesRef.current)
    const recover = () => recoverActivePreviews(storiesRef.current)
    const timer = window.setInterval(recover, previewRecoveryIntervalMs)
    const recoverWhenShown = () => {
      if (document.visibilityState === "visible") recover()
    }
    document.addEventListener("visibilitychange", recoverWhenShown)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", recoverWhenShown)
    }
  }, [
    backlog.loading,
    ensureProjectPreviewUrl,
    recoveryState,
    recoverActivePreviews,
  ])
}
