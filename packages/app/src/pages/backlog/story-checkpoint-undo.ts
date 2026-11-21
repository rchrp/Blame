import type * as React from "react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { DrawerTarget } from "@/components/backlog/shared/backlog-types"

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
