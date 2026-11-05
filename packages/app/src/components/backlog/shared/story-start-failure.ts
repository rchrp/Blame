import type { UserStory } from "@/components/backlog/data/backlog-data"

// Why a queued story is not moving: its last start failed, and the queue
// tries again on its own. Queueing a story or starting its agent clears
// the error, so on a queued story it can only come from a start.
export function storyStartFailure(
  story: Pick<UserStory, "agentLastError" | "status">
) {
  if (story.status !== "ready" || !story.agentLastError) return undefined
  const detail = story.agentLastError
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
  return detail ? `Couldn't start the agent: ${detail}` : undefined
}
