import * as React from "react"

import { useBacklogSelector } from "@/components/backlog/data/backlog-store"
import {
  storyWaitText,
  useStoryWaits,
} from "@/components/backlog/data/story-queue-waits"
import {
  epicActivity,
  epicBoard,
  type EpicBoardStory,
} from "@/components/orchestrator/data/epic-board"
import type { Epic } from "@/components/orchestrator/data/epic-data"
import { useEpicStore } from "@/components/orchestrator/data/epic-store"

// The project's stories that belong to an epic, with only what the board
// shows: an agent saving its run does not redraw it.
function epicStories(backlog: { stories: readonly EpicBoardStory[] }) {
  return backlog.stories
    .filter((story) => story.epicId)
    .map((story): EpicBoardStory => ({
      agentLastError: story.agentLastError,
      agentModels: story.agentModels?.map(({ modelId, providerId }) => ({
        modelId,
        providerId,
      })),
      agentStatus: story.agentStatus,
      createdAt: story.createdAt,
      epicId: story.epicId,
      id: story.id,
      modelIntent: story.modelIntent,
      requestedModel: story.requestedModel,
      status: story.status,
      storyNumber: story.storyNumber,
      title: story.title,
      updatedAt: story.updatedAt,
    }))
}

function sameStories(
  left: readonly EpicBoardStory[],
  right: readonly EpicBoardStory[]
) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function useEpicStories() {
  return useBacklogSelector(epicStories, sameStories)
}

function useBoardOf(stories: readonly EpicBoardStory[]) {
  const waits = useStoryWaits()
  const states = useEpicStore().states
  return React.useCallback(
    (epic: Pick<Epic, "id" | "status" | "engineSessionId">) => {
      const state = states.get(epic.id)
      return epicBoard({
        epic,
        stories,
        wait: (id) => waits.get(id),
        waitText: storyWaitText,
        ...(state
          ? { orchestrator: state.conversation, blocked: state.blocked ?? [] }
          : {}),
      })
    },
    [states, stories, waits]
  )
}

export function useEpicBoard(epic: Epic | undefined) {
  const stories = useEpicStories()
  const boardOf = useBoardOf(stories)
  return React.useMemo(() => (epic ? boardOf(epic) : []), [boardOf, epic])
}

/** Each epic's sidebar dot, by id. */
export function useEpicActivities(epics: readonly Epic[]) {
  const stories = useEpicStories()
  const boardOf = useBoardOf(stories)
  const states = useEpicStore().states
  return React.useMemo(
    () =>
      new Map(
        epics.map((epic) => [
          epic.id,
          epicActivity(epic, boardOf(epic), states.get(epic.id)?.conversation),
        ])
      ),
    [boardOf, epics, states]
  )
}
