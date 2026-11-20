import type * as React from "react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { DrawerTarget } from "@/components/backlog/shared/backlog-types"
import type { Platform } from "@/context/platform"
import { storyLocation } from "./story-engine"

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

/** Undoes a message to the story's agent and what followed it, files included when they were snapshotted. */
export async function rewindStoryMessage(
  platform: Platform,
  story: UserStory,
  target: { to: number; workspace: boolean }
) {
  if (!platform.engine)
    throw new Error("The desktop agent engine is not available.")
  if (!story.engineSessionId)
    throw new Error("This user story has no agent conversation.")
  return platform.engine.call("rewind", {
    session: story.engineSessionId,
    location: storyLocation(story.workspaceMode ?? "direct", platform.platform),
    to: target.to,
    restoreWorkspace: target.workspace,
  })
}
