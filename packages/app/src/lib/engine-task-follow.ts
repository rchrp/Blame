import type { SessionRecord } from "@blame/engine-client"
import type { EnginePlatformClient } from "@blame/agent-runtime/engine-protocol"

// The records of an engine task the renderer started with its own id, for
// a long task's progress. A task is a session the engine creates once the
// host has prepared it (a scan can take seconds): following starts when the
// task starts running, so the follower never looks for a session that does
// not exist yet. Each record is delivered once.
export function followEngineTask(
  engine: Pick<EnginePlatformClient, "follow" | "onActivity">,
  task: string,
  onRecords: (records: SessionRecord[]) => void,
  onStarted?: () => void
) {
  let stopFollowing: (() => void) | undefined
  const start = () => {
    if (stopFollowing) return
    onStarted?.()
    stopFollowing = engine.follow(task, (event) => {
      if (event.type === "records") onRecords(event.records)
    })
  }
  const stopWatching = engine.onActivity((event) => {
    if (event.session === task && event.running) start()
  })
  return () => {
    stopWatching()
    stopFollowing?.()
  }
}
