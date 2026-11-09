import * as React from "react"
import { toast } from "sonner"

import type { UserStory, UserStoryUpdate } from "@/components/backlog/data/backlog-data"
import { inactiveStoryFields } from "./story-runtime-state"

type UpdateStory = (
  story: UserStory,
  input: UserStoryUpdate,
  options?: { cleanup?: boolean }
) => Promise<UserStory>

// How a story in review finishes when it has nothing to merge or commit.
export function useReviewCompletion(updateStory: UpdateStory) {
  const markReviewStoryDone = React.useCallback(
    async (story: UserStory) => {
      const doneStory = await updateStory(story, {
        ...inactiveStoryFields(),
        agentLastError: null,
        agentLastEvent: "Marked as done.",
        status: "done",
      })
      toast.success("Story marked as done", { position: "bottom-right" })
      return doneStory
    },
    [updateStory]
  )

  return { markReviewStoryDone }
}
