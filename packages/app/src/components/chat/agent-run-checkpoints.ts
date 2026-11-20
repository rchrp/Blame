export type CheckpointRun = {
  checkpointRunCount?: number | null
}

// Which turns of the timeline can be undone: the conversation says it per
// turn (an engine turn whose opening message has a rewind target).
export function checkpointRunTargets(runs: CheckpointRun[]) {
  return runs.map((run) =>
    run.checkpointRunCount
      ? { checkpointRunCount: run.checkpointRunCount }
      : undefined
  )
}
