export type CheckpointRun = {
  checkpointRunCount?: number | null
  clineSessionId?: string | null
}

export function checkpointRunTargets(runs: CheckpointRun[]) {
  let checkpointRunCount = 0
  return runs.map((run) => {
    // An engine turn says itself whether it can be undone (no Cline session).
    if (!run.clineSessionId && !run.checkpointRunCount) return undefined
    checkpointRunCount = run.checkpointRunCount ?? checkpointRunCount + 1
    return { checkpointRunCount }
  })
}

export function nextCheckpointRunCount(runs: CheckpointRun[]) {
  return (
    runs.reduce(
      (maximum, run) => Math.max(maximum, run.checkpointRunCount ?? 0),
      runs.filter((run) => run.clineSessionId).length
    ) + 1
  )
}
