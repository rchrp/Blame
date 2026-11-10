import type * as React from "react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { DrawerTarget } from "@/components/backlog/shared/backlog-types"
import type { Platform } from "@/context/platform"

export function replaceStoryAfterUndo(
  story: UserStory,
  storiesRef: { current: UserStory[] },
  setDrawerTarget: React.Dispatch<
    React.SetStateAction<DrawerTarget | undefined>
  >
) {
  storiesRef.current = storiesRef.current.map((currentStory) =>
    currentStory.id === story.id ? story : currentStory
  )
  setDrawerTarget((current) =>
    current?.userStory?.id === story.id
      ? { ...current, userStory: story }
      : current
  )
}

export async function restoreStoryCheckpoint(
  platform: Platform,
  story: UserStory,
  sessionId: string | null | undefined,
  checkpointRunCount: number
) {
  if (!platform.agent)
    throw new Error("Desktop agent runtime is not available.")
  if (!sessionId) throw new Error("This message has no Cline session.")
  if (!story.worktree)
    throw new Error("This user story has no active worktree.")
  return platform.agent.sessions.restoreCheckpoint({
    checkpointRunCount,
    cwd: story.worktree,
    restore: {
      messages: true,
      omitCheckpointMessageFromSession: true,
      workspace: true,
    },
    sessionId,
  })
}
