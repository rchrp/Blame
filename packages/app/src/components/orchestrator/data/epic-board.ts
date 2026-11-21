import type { StoryWaitReason } from "@blame/agent-runtime/engine-protocol"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { Epic } from "@/components/orchestrator/data/epic-data"

// An epic's board, grouped by what the person owes (docs/orchestrator.md,
// "The screen"). Until the orchestrator can ask its own questions, a story
// needs the person when nobody else can move it: a start only the person can
// unblock, an agent stopped while the epic runs, or a review the
// orchestrator cannot do (the epic is paused or has no conversation yet).

export type EpicBoardGroupId =
  "needs-you" | "working" | "queued" | "merged" | "rejected"

export type EpicBoardStory = Pick<
  UserStory,
  | "agentLastError"
  | "agentModels"
  | "agentStatus"
  | "createdAt"
  | "epicId"
  | "id"
  | "modelIntent"
  | "requestedModel"
  | "status"
  | "storyNumber"
  | "title"
  | "updatedAt"
>

export type EpicBoardEntry<Story extends EpicBoardStory = EpicBoardStory> = {
  story: Story
  // What the card says of the story's state, in a few words; none says
  // nothing more than its group.
  note?: string
  // The note is something to act on.
  alert?: boolean
}

export type EpicBoardGroup<Story extends EpicBoardStory = EpicBoardStory> = {
  id: EpicBoardGroupId
  title: string
  entries: EpicBoardEntry<Story>[]
}

export const epicBoardGroupTitles: Record<EpicBoardGroupId, string> = {
  "needs-you": "Needs you",
  working: "Working",
  queued: "Queued",
  merged: "In the epic branch",
  rejected: "Rejected",
}

const groupOrder: EpicBoardGroupId[] = [
  "needs-you",
  "working",
  "queued",
  "merged",
  "rejected",
]

// Waits that end by themselves; every other one waits for the person.
const passingWaits = new Set<StoryWaitReason["kind"]>([
  "dependencies",
  "initialization",
  "runtime",
])

export type EpicBoardInput<Story extends EpicBoardStory> = {
  epic: Pick<Epic, "id" | "status" | "engineSessionId">
  stories: readonly Story[]
  wait: (storyId: string) => StoryWaitReason | undefined
  waitText: (reason: StoryWaitReason) => string
}

export function epicBoard<Story extends EpicBoardStory>(
  input: EpicBoardInput<Story>
): EpicBoardGroup<Story>[] {
  const groups = new Map<EpicBoardGroupId, EpicBoardEntry<Story>[]>(
    groupOrder.map((id) => [id, []])
  )
  const stories = input.stories
    .filter((story) => story.epicId === input.epic.id)
    .sort((left, right) => left.storyNumber - right.storyNumber)
  for (const story of stories) {
    const placed = placeStory(story, input)
    groups.get(placed.group)!.push({
      story,
      ...(placed.note ? { note: placed.note } : {}),
      ...(placed.alert ? { alert: true } : {}),
    })
  }
  return groupOrder.map((id) => ({
    id,
    title: epicBoardGroupTitles[id],
    entries: groups.get(id)!,
  }))
}

function placeStory<Story extends EpicBoardStory>(
  story: Story,
  input: EpicBoardInput<Story>
): { group: EpicBoardGroupId; note?: string; alert?: boolean } {
  const running = input.epic.status === "active"
  switch (story.status) {
    case "done":
      return { group: "merged" }
    case "discarded":
      return { group: "rejected" }
    case "in-review":
      return running && input.epic.engineSessionId
        ? { group: "working", note: "The orchestrator reviews it" }
        : { group: "needs-you", note: "Ready for your review", alert: true }
    case "in-progress":
      if (story.agentStatus === "Paused")
        return running
          ? { group: "needs-you", note: "Agent paused", alert: true }
          : { group: "working", note: "Paused with the epic" }
      return { group: "working" }
    case "ready": {
      if (story.agentLastError)
        return { group: "needs-you", note: story.agentLastError, alert: true }
      const reason = input.wait(story.id)
      if (!reason) return { group: "queued" }
      const note = input.waitText(reason)
      return passingWaits.has(reason.kind)
        ? { group: "queued", note }
        : { group: "needs-you", note, alert: true }
    }
    case "backlog":
      return { group: "queued", note: "Held: not queued yet" }
  }
}

export type EpicActivity = "needs-you" | "working" | "paused" | "done"

/** The dot of the epic in the sidebar; none while nothing happens. */
export function epicActivity(
  epic: Pick<Epic, "status">,
  groups: readonly EpicBoardGroup[]
): EpicActivity | undefined {
  if (epic.status === "completed") return "done"
  if (epic.status === "discarded") return undefined
  const count = (id: EpicBoardGroupId) =>
    groups.find((group) => group.id === id)?.entries.length ?? 0
  if (count("needs-you")) return "needs-you"
  if (epic.status === "paused") return "paused"
  if (count("working") || count("queued")) return "working"
  if (count("merged")) return "done"
  return undefined
}

export const epicActivityLabels: Record<EpicActivity, string> = {
  "needs-you": "Needs you",
  working: "Working",
  paused: "Paused",
  done: "Done",
}

/** The stories Pause all stops: those whose agent works now. */
export function workingStoryIds(
  epic: Pick<Epic, "id">,
  stories: readonly EpicBoardStory[]
) {
  return stories
    .filter(
      (story) =>
        story.epicId === epic.id &&
        story.status === "in-progress" &&
        story.agentStatus === "Running"
    )
    .map((story) => story.id)
}
