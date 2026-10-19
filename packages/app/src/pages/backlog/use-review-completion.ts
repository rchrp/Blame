import * as React from "react"
import { toast } from "sonner"

import type { UserStory, UserStoryUpdate } from "@/components/backlog/data/backlog-data"
import { navigate } from "@/components/navigation/navigation"
import { celebrateStory } from "@/lib/celebrate"
import { inactiveStoryFields } from "./story-runtime-state"

type UpdateStory = (
  story: UserStory,
  input: UserStoryUpdate,
  options?: { cleanup?: boolean }
) => Promise<UserStory>

// Ways a story in review can finish without a merge.
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

  // Direct stories already live in the project folder: approving keeps the
  // changes there for the person to commit; nothing is merged.
  const approveDirectStory = React.useCallback(
    async (story: UserStory) => {
      const doneStory = await updateStory(story, {
        ...inactiveStoryFields(),
        agentLastError: null,
        agentLastEvent: "Approved. Changes are in the project folder.",
        status: "done",
      })
      celebrateStory(story.id)
      toast.success("Story approved", {
        action: { label: "Open Git", onClick: () => navigate("/git") },
        description: "The changes are in your project folder, ready to commit.",
        position: "bottom-right",
      })
      return doneStory
    },
    [updateStory]
  )

  return { approveDirectStory, markReviewStoryDone }
}
