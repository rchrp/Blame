import type { SessionRecord } from "@blame/engine-client"
import type { EnginePlatformClient } from "@blame/agent-runtime/engine-protocol"

// The records of an engine task the renderer started with its own id, for
// a long task's progress. Follow it right after the call that runs it: the
// host holds the follow until the engine has the task's session (a project
// scan can come first). Each record is delivered once.
export function followEngineTask(
  engine: Pick<EnginePlatformClient, "follow">,
  task: string,
  onRecords: (records: SessionRecord[]) => void
) {
  return engine.follow(task, (event) => {
    if (event.type === "records") onRecords(event.records)
  })
}
