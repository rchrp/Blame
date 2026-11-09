import * as React from "react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { usePlatform } from "@/context/platform"
import { storyWorkToPush } from "./story-work-to-push"

const refreshDelayMs = 15_000

// Whether the story's open pull request is behind its branch: the agent
// reworked the story after changes were requested. Checked on the host, when
// the story is saved and every few seconds while the app is visible.
export function useStoryWorkToPush(story: UserStory | undefined) {
  const { workspace } = usePlatform()
  const [checked, setChecked] = React.useState<{
    storyId: string
    workToPush: boolean
  }>()
  const storyId = story?.id
  const branch = story?.branch
  const pullRequestUrl = story?.pullRequestUrl
  const worktree = story?.worktree
  const updatedAt = story?.updatedAt
  const inReview = story?.status === "in-review"
  const checkable = Boolean(
    workspace && storyId && inReview && branch && pullRequestUrl && worktree
  )

  React.useEffect(() => {
    if (!workspace || !storyId || !checkable) return
    let cancelled = false
    const refresh = () => {
      void storyWorkToPush(
        { branch, pullRequestUrl, worktree },
        workspace
      ).then((workToPush) => {
        if (!cancelled) setChecked({ storyId, workToPush })
      })
    }
    refresh()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh()
    }, refreshDelayMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [
    branch,
    checkable,
    pullRequestUrl,
    storyId,
    updatedAt,
    workspace,
    worktree,
  ])

  return (
    checkable &&
    checked !== undefined &&
    checked.storyId === storyId &&
    checked.workToPush
  )
}
