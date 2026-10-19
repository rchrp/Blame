import type { BacklogAction } from "@/components/backlog/data/backlog-data"

const backlogStorySelectionEvent = "backlog:story-selection"

let selectedStoryId: string | undefined
let selectedStoryAction: BacklogAction | undefined

// Opens a story in the backlog drawer. An action such as "View Diff" opens
// the matching tab instead of the story itself.
export function selectBacklogStory(
  storyId: string | undefined,
  action?: BacklogAction
) {
  selectedStoryId = storyId
  selectedStoryAction = storyId ? action : undefined
  window.dispatchEvent(new Event(backlogStorySelectionEvent))
}

export function selectedBacklogStoryId() {
  return selectedStoryId
}

// Read once: the action applies to the selection that asked for it only.
export function takeSelectedBacklogStoryAction() {
  const action = selectedStoryAction
  selectedStoryAction = undefined
  return action
}

export function subscribeToBacklogStorySelection(callback: () => void) {
  window.addEventListener(backlogStorySelectionEvent, callback)
  return () => window.removeEventListener(backlogStorySelectionEvent, callback)
}
