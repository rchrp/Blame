export type DiffStatsValue = {
  additions?: number
  deletions?: number
}

export type UserStoryDiffStats = {
  additions: number
  deletions: number
  files: number
}

export function totalDiffStats(diffs: DiffStatsValue[]): UserStoryDiffStats {
  return diffs.reduce<UserStoryDiffStats>(
    (stats, diff) => ({
      additions: stats.additions + (diff.additions ?? 0),
      deletions: stats.deletions + (diff.deletions ?? 0),
      files: stats.files + 1,
    }),
    { additions: 0, deletions: 0, files: 0 }
  )
}

type DiffStatsTarget = { id: string }

// A story whose diff could not be read (the Blame Runtime is stopped) keeps
// the numbers it last showed.
export function mergeUserStoryDiffStats(
  current: Map<string, UserStoryDiffStats>,
  targets: DiffStatsTarget[],
  results: Array<{ id: string; stats?: UserStoryDiffStats }>
) {
  const next = retainedUserStoryDiffStats(current, targets)
  for (const result of results) {
    if (result.stats) next.set(result.id, result.stats)
  }
  return sameUserStoryDiffStats(current, next) ? current : next
}

export function pruneUserStoryDiffStats(
  current: Map<string, UserStoryDiffStats>,
  targets: DiffStatsTarget[]
) {
  const next = retainedUserStoryDiffStats(current, targets)
  return sameUserStoryDiffStats(current, next) ? current : next
}

function retainedUserStoryDiffStats(
  current: Map<string, UserStoryDiffStats>,
  targets: DiffStatsTarget[]
) {
  const storyIds = new Set(targets.map((target) => target.id))
  return new Map([...current].filter(([id]) => storyIds.has(id)))
}

function sameUserStoryDiffStats(
  current: Map<string, UserStoryDiffStats>,
  next: Map<string, UserStoryDiffStats>
) {
  if (current.size !== next.size) return false
  return [...current].every(([id, stats]) => {
    const nextStats = next.get(id)
    if (!nextStats) return false
    return (
      stats.additions === nextStats.additions &&
      stats.deletions === nextStats.deletions &&
      stats.files === nextStats.files
    )
  })
}
