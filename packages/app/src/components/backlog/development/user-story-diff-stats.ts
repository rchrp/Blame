import * as React from "react"
import { storyWorkingDiff } from "./story-working-diff.ts"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import {
  totalDiffStats,
  type UserStoryDiffStats,
} from "@/components/backlog/development/development-diff-stats-data"
import {
  normalizeDiffs,
  parseGitDiff,
} from "@/components/backlog/development/development-workspace"
import type { Platform } from "@/context/platform"
import {
  measurePerformanceOperation,
  recordPerformanceCount,
  recordPerformanceMetric,
} from "@/lib/performance-diagnostics"
import {
  initialUserStoryDiffTargets,
  suspendedUserStoryDiffTargetCount,
  userStoryDiffTargetKey,
  type UserStoryDiffTarget,
} from "@/components/backlog/development/user-story-diff-target-selection"

const diffStatsRefreshDelayMs = 15_000
const maximumConcurrentDiffStats = 2
const historicalDiffStatsRequests = new Map<
  string,
  Promise<UserStoryDiffStats>
>()

export type { UserStoryDiffStats } from "@/components/backlog/development/development-diff-stats-data"

type UserStoryDiffResult = {
  id: string
  stats?: UserStoryDiffStats
}

type UserStoryDiffStatsSetter = React.Dispatch<
  React.SetStateAction<Map<string, UserStoryDiffStats>>
>

export function useUserStoryDiffStats(
  stories: UserStory[],
  workspace: Platform["workspace"],
  repositoryRoot?: string
) {
  const [stats, setStats] = React.useState(
    () => new Map<string, UserStoryDiffStats>()
  )
  const loadedTargetKeys = React.useRef(new Set<string>())
  const serializedTargets = serializedUserStoryDiffTargets(
    stories,
    repositoryRoot
  )
  const targets = React.useMemo(
    () => JSON.parse(serializedTargets) as UserStoryDiffTarget[],
    [serializedTargets]
  )

  React.useEffect(() => {
    return subscribeUserStoryDiffStats(
      targets,
      workspace,
      setStats,
      loadedTargetKeys.current
    )
  }, [targets, workspace])

  return stats
}

// The story's total diff. Same parsing and filtering as the Diff tab, so the
// board card, the drawer and the Diff tab always show the same numbers.
export function diffStatsFromPatch(patch: string): UserStoryDiffStats {
  return totalDiffStats(normalizeDiffs(parseGitDiff(patch)))
}

function subscribeUserStoryDiffStats(
  targets: UserStoryDiffTarget[],
  workspace: Platform["workspace"],
  setStats: UserStoryDiffStatsSetter,
  loadedTargetKeys: Set<string>
) {
  let cancelled = false
  let loading = false
  let idleCallback: number | undefined
  const load = async (selectedTargets: UserStoryDiffTarget[]) => {
    if (loading) return
    loading = true
    try {
      await loadUserStoryDiffStats(
        selectedTargets,
        targets,
        workspace,
        setStats,
        loadedTargetKeys,
        () => cancelled
      )
    } finally {
      loading = false
    }
  }
  const schedule = (selectedTargets: UserStoryDiffTarget[]) => {
    if (!selectedTargets.length || idleCallback !== undefined) return
    idleCallback = window.requestIdleCallback(() => {
      idleCallback = undefined
      void load(selectedTargets)
    })
  }
  const initialTargets = initialUserStoryDiffTargets(targets, loadedTargetKeys)
  const workingTargets = targets.filter(
    (target) => target.mode === "working" && target.refresh
  )
  recordPerformanceMetric(
    "backlog.diff_stats.suspended_target_count",
    suspendedUserStoryDiffTargetCount(targets)
  )
  recordPerformanceMetric(
    "backlog.diff_stats.reused_target_count",
    targets.length -
      suspendedUserStoryDiffTargetCount(targets) -
      initialTargets.length
  )
  schedule(initialTargets)
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") schedule(workingTargets)
  }, diffStatsRefreshDelayMs)
  return () => {
    cancelled = true
    clearInterval(timer)
    if (idleCallback !== undefined) window.cancelIdleCallback(idleCallback)
  }
}

async function loadUserStoryDiffStats(
  selectedTargets: UserStoryDiffTarget[],
  retainedTargets: UserStoryDiffTarget[],
  workspace: Platform["workspace"],
  setStats: UserStoryDiffStatsSetter,
  loadedTargetKeys: Set<string>,
  cancelled: () => boolean
) {
  if (!workspace || !retainedTargets.length) {
    setStats((current) => pruneUserStoryDiffStats(current, retainedTargets))
    return
  }
  if (!selectedTargets.length) return
  recordPerformanceCount("backlog.diff_stats.refresh")
  recordPerformanceMetric(
    "backlog.diff_stats.target_count",
    selectedTargets.length
  )
  const results = await measurePerformanceOperation(
    "backlog.diff_stats.refresh",
    () => loadUserStoryDiffStatsConcurrently(selectedTargets, workspace)
  )
  if (cancelled()) return
  selectedTargets.forEach((target, index) => {
    if (results[index]?.stats)
      loadedTargetKeys.add(userStoryDiffTargetKey(target))
  })
  setStats((current) =>
    mergeUserStoryDiffStats(current, retainedTargets, results)
  )
}

function serializedUserStoryDiffTargets(
  stories: UserStory[],
  repositoryRoot?: string
): string {
  return JSON.stringify(
    stories.flatMap<UserStoryDiffTarget>((story) => {
      if (
        (story.status === "in-progress" || story.status === "in-review") &&
        story.worktree
      ) {
        return [
          {
            id: story.id,
            mode: "working",
            refresh: story.agentStatus !== "Running",
            root: story.worktree,
            baseCommit: story.baseCommit,
            repositoryRoot,
          },
        ]
      }
      if (story.status !== "done" || !story.mergeCommit || !repositoryRoot) {
        return []
      }
      return [
        {
          from: story.baseCommit ?? `${story.mergeCommit}^`,
          id: story.id,
          mode: "historical",
          root: repositoryRoot,
          to: story.mergeCommit,
        },
      ]
    })
  )
}

async function loadUserStoryDiffStatsConcurrently(
  targets: UserStoryDiffTarget[],
  workspace: NonNullable<Platform["workspace"]>
) {
  const results = new Array<UserStoryDiffResult>(targets.length)
  let nextIndex = 0
  const loadNext = async () => {
    while (nextIndex < targets.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await loadUserStoryDiffStat(targets[index], workspace)
    }
  }
  const workerCount = Math.min(maximumConcurrentDiffStats, targets.length)
  await Promise.all(Array.from({ length: workerCount }, loadNext))
  return results
}

async function loadUserStoryDiffStat(
  target: UserStoryDiffTarget,
  workspace: NonNullable<Platform["workspace"]>
): Promise<UserStoryDiffResult> {
  try {
    const stats =
      target.mode === "historical"
        ? await cachedHistoricalDiffStats(target, workspace)
        : await loadUserStoryDiffStatValue(target, workspace)
    return { id: target.id, stats }
  } catch {
    return { id: target.id }
  }
}

function cachedHistoricalDiffStats(
  target: Extract<UserStoryDiffTarget, { mode: "historical" }>,
  workspace: NonNullable<Platform["workspace"]>
) {
  const key = `${target.root}:${target.from}:${target.to}`
  const current = historicalDiffStatsRequests.get(key)
  if (current) return current
  const request = loadUserStoryDiffStatValue(target, workspace).catch(
    (error) => {
      if (historicalDiffStatsRequests.get(key) === request)
        historicalDiffStatsRequests.delete(key)
      throw error
    }
  )
  historicalDiffStatsRequests.set(key, request)
  return request
}

async function loadUserStoryDiffStatValue(
  target: UserStoryDiffTarget,
  workspace: NonNullable<Platform["workspace"]>
) {
  if (target.mode === "working") {
    return diffStatsFromPatch(await storyWorkingDiff(target, workspace))
  }
  if (workspace.gitDiffStats) {
    return workspace.gitDiffStats({
      from: target.from,
      root: target.root,
      to: target.to,
    })
  }
  const patch = await workspace.gitDiffBetween(target)
  return diffStatsFromPatch(patch)
}

function mergeUserStoryDiffStats(
  current: Map<string, UserStoryDiffStats>,
  targets: UserStoryDiffTarget[],
  results: UserStoryDiffResult[]
) {
  const next = retainedUserStoryDiffStats(current, targets)
  for (const result of results) {
    if (result.stats) next.set(result.id, result.stats)
    else next.delete(result.id)
  }
  return sameUserStoryDiffStats(current, next) ? current : next
}

function pruneUserStoryDiffStats(
  current: Map<string, UserStoryDiffStats>,
  targets: UserStoryDiffTarget[]
) {
  const next = retainedUserStoryDiffStats(current, targets)
  return sameUserStoryDiffStats(current, next) ? current : next
}

function retainedUserStoryDiffStats(
  current: Map<string, UserStoryDiffStats>,
  targets: UserStoryDiffTarget[]
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
