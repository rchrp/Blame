import * as React from "react"
import { toast } from "sonner"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { parseUserStory } from "@/components/backlog/data/backlog-api"
import { usePlatform } from "@/context/platform"

// How a story in review finishes when it has nothing to merge or commit:
// done, its runtime cleaned up by the story service.
export function useReviewCompletion() {
  const engine = usePlatform().engine
  const markReviewStoryDone = React.useCallback(
    async (story: UserStory) => {
      if (!engine) throw new Error("The desktop agent engine is not available.")
      const doneStory = parseUserStory(
        await engine.call("storyComplete", { storyId: story.id })
      )
      toast.success("Story marked as done", { position: "bottom-right" })
      return doneStory
    },
    [engine]
  )

  return { markReviewStoryDone }
}
