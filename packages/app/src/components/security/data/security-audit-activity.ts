// An audit agent's progress, from its engine task's records: the task is a
// session, followed like a conversation, and its tool calls say how much
// code the agent has read so far.
import type { FollowEvent, SessionRecord } from "@blame/engine-client"
import type { EnginePlatformClient } from "@blame/agent-runtime/engine-protocol"

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
 * Follows a task until the returned function is called. The task's session
 * exists only once the engine has started it, after the call that runs it
 * was sent: a follow that the engine refuses is tried again.
 */
export function followTask(
  engine: Pick<EnginePlatformClient, "follow">,
  session: string,
  onActivity: (activity: TaskActivity) => void,
  retryMs = 500
) {
  let activity = { reads: 0, searches: 0, lastSeq: 0 }
  let ended = false
  let unfollow: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const attach = () => {
    if (ended) return
    unfollow = engine.follow(session, (event: FollowEvent) => {
      if (event.type === "records") {
        const next = withRecords(activity, event.records)
        const changed =
          next.reads !== activity.reads || next.searches !== activity.searches
        activity = next
        if (changed) onActivity(next)
      } else if (event.type === "state" && event.state === "stopped") {
        unfollow?.()
        unfollow = undefined
        if (!ended) timer = setTimeout(attach, retryMs)
      }
    })
  }
  attach()
  return () => {
    ended = true
    clearTimeout(timer)
    unfollow?.()
  }
}
