import * as React from "react"
import { toast } from "sonner"

import type {
  UserStory,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import type { usePlatform } from "@/context/platform"
import type { useProjects } from "@/context/projects"
import { cleanupMergedStory } from "./story-post-merge"
import {
  applyPullRequestState,
  isSyncedStory,
  type PullRequestSyncOutcome,
  type SyncedStory,
} from "./story-pull-request-sync"
import { activeStory } from "./story-runtime-state"
import { storiesInTransition, withStoryTransition } from "./story-transitions"

const pollIntervalMs = 60_000

type StoryPullRequestSyncInput = {
  drawerStoryId: string | undefined
  platform: ReturnType<typeof usePlatform>
  projects: ReturnType<typeof useProjects>
  stories: UserStory[]
  storiesRef: { current: UserStory[] }
  updateStory: (
    story: UserStory,
    input: UserStoryUpdate,
    options: { cleanup: false }
  ) => Promise<UserStory>
}

// A story in review with a pull request asks GitHub (gh pr view, on the host)
// what became of it: when the backlog loads, when its drawer opens, then every
// minute. Once gh is missing or signed out nothing is asked again until the
// drawer of such a story opens or the stories to watch change, and nothing is
// shown: Open PR already says how to fix gh when the person uses it.
export function useStoryPullRequestSync({
  drawerStoryId,
  platform,
  projects,
  stories,
  storiesRef,
  updateStory,
}: StoryPullRequestSyncInput) {
  const agent = platform.agent
  const repositoryRoot = projects.activeProject?.path
  const watched = stories.filter(isSyncedStory)
  const watchedKey = watched
    .map((story) => `${story.id} ${story.pullRequestUrl}`)
    .join("\n")
  const watchedDrawerStoryId = watched.find(
    (story) => story.id === drawerStoryId
  )?.id

  // False when gh cannot answer: the rest is not asked either.
  const syncStories = React.useEffectEvent(async () => {
    if (!agent || !repositoryRoot) return false
    for (const story of storiesRef.current.filter(isSyncedStory)) {
      if (storiesInTransition().has(story.id)) continue
      const state = await agent
        .pullRequestState({ repositoryRoot, url: story.pullRequestUrl })
        .catch(() => undefined)
      if (!state) continue
      if (state.status === "unavailable") return false
      // The person may have merged or rejected the story while GitHub answered.
      const current = activeStory(story, storiesRef.current)
      if (!isSyncedStory(current)) continue
      if (current.pullRequestUrl !== story.pullRequestUrl) continue
      try {
        const outcome = await withStoryTransition(current.id, () =>
          applyPullRequestState(current, state, {
            cleanupMergedStory: (merged) =>
              cleanupMergedStory(merged, platform, repositoryRoot),
            updateStory,
          })
        )
        if (outcome) notifySynced(current, outcome)
      } catch (error) {
        toast.error("Couldn't update the story from its pull request", {
          description: errorMessage(error),
          id: `story-pull-request-sync-${current.id}`,
          position: "bottom-right",
        })
      }
    }
    return true
  })

  React.useEffect(() => {
    if (!agent || !repositoryRoot || !watchedKey) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const answered = await syncStories()
      if (!stopped && answered) timer = setTimeout(poll, pollIntervalMs)
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [agent, repositoryRoot, watchedDrawerStoryId, watchedKey])
}

function notifySynced(story: SyncedStory, outcome: PullRequestSyncOutcome) {
  if (outcome === "merged") {
    toast.success("Pull request merged", {
      description: `${story.title} is done.`,
      position: "bottom-right",
    })
    return
  }
  toast.info("Pull request closed without merging", {
    description: `${story.title} can be rejected or merged from Blame again.`,
    position: "bottom-right",
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
