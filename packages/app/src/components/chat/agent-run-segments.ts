import type { UserStoryAgentActivity } from "@/components/backlog/data/backlog-data"

/**
 * A stretch of one turn's work. Messages the person sent into the running
 * turn (steers) split it: each opens a segment, shown as their own message
 * where it joined, with the agent's acknowledgement beside it and the work
 * that followed under it. The turn stays one run around them.
 */
export type AgentRunSegment = {
  /** The steered message that opens it (none for the first segment). */
  steer?: UserStoryAgentActivity
  /** The agent's short answer to it: its first message before any tool. */
  acknowledgement?: UserStoryAgentActivity
  activities: UserStoryAgentActivity[]
}

export function agentRunSegments(
  activities: UserStoryAgentActivity[]
): AgentRunSegment[] {
  const segments: AgentRunSegment[] = [{ activities: [] }]
  for (const activity of activities) {
    const segment = segments.at(-1)!
    if (activity.kind === "user") {
      segments.push({ activities: [], steer: activity })
      continue
    }
    if (
      segment.steer &&
      !segment.acknowledgement &&
      activity.kind === "message" &&
      activity.messageKind !== "final" &&
      !segment.activities.some((earlier) => earlier.kind !== "reasoning")
    ) {
      segment.acknowledgement = activity
      continue
    }
    segment.activities.push(activity)
  }
  return segments
}
