import type { UserStory } from "@/components/backlog/data/backlog-data"

// Direct stories share the project folder, so only one runs or waits for
// review at a time; the next one starts once it is merged or discarded.
export function directStorySlots(stories: UserStory[], starting: number) {
  return activeDirectStory(stories) || starting > 0 ? 0 : 1
}

export function directQueueNotice(stories: UserStory[]) {
  const active = activeDirectStory(stories)
  if (!active) return undefined
  const queued = stories.some((story) => story.status === "ready")
  if (!queued) return undefined
  return active.status === "in-review"
    ? "Waiting for the Direct story in review"
    : "Waiting for the Direct story in progress"
}

function activeDirectStory(stories: UserStory[]) {
  return stories.find(
    (story) =>
      story.workspaceMode === "direct" &&
      (story.status === "in-progress" || story.status === "in-review")
  )
}
