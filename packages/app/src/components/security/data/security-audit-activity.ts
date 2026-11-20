// An audit agent's progress, from its engine task's records: the task is a
// session, followed like a conversation, and its tool calls say how much
// code the agent has read so far.
import type { SessionRecord } from "@blame/engine-client"
import type { EnginePlatformClient } from "@blame/agent-runtime/engine-protocol"
import { followEngineTask } from "../../../lib/engine-task-follow.ts"

export type TaskActivity = { reads: number; searches: number }

/** The activity with the records added: each seq is counted once. */
export function withRecords(
  activity: TaskActivity & { lastSeq: number },
  records: SessionRecord[]
) {
  let { reads, searches, lastSeq } = activity
  for (const record of records) {
    if (record.seq <= lastSeq) continue
    lastSeq = record.seq
    if (record.type !== "tool_call_started") continue
    if (record.name === "read_code") reads += 1
    else if (record.name === "search_code") searches += 1
  }
  return { reads, searches, lastSeq }
}

export function activityDetail({ reads, searches }: TaskActivity) {
  if (!reads && !searches) return undefined
  return [
    reads ? `${reads} code read${reads === 1 ? "" : "s"}` : "",
    searches ? `${searches} search${searches === 1 ? "" : "es"}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/**
 * Follows a task, right after the call that runs it, until the returned
 * function is called: the host holds the follow until the task's session
 * exists.
 */
export function followTask(
  engine: Pick<EnginePlatformClient, "follow">,
  session: string,
  onActivity: (activity: TaskActivity) => void
) {
  let activity = { reads: 0, searches: 0, lastSeq: 0 }
  return followEngineTask(engine, session, (records) => {
    const next = withRecords(activity, records)
    const changed =
      next.reads !== activity.reads || next.searches !== activity.searches
    activity = next
    if (changed) onActivity(next)
  })
}
