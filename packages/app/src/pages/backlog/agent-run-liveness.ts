import type { UserStory, UserStoryAgentRun } from "@/components/backlog/data/backlog-data"

// A run that just started may not be registered as live for a moment (the
// session is created before its first message is sent). Only runs older
// than this are judged by their session.
export const deadSessionGraceMs = 15_000

export function runningAgentRunsForStory(story: UserStory) {
  const runs = new Map(
    (story.runningAgentRuns ?? []).map((run) => [run.id, run])
  )
  story.agentRuns?.forEach((run) => runs.set(run.id, run))
  return [...runs.values()].filter((run) => run.status === "running")
}

// Runs recorded as running whose session the desktop app no longer runs:
// the app restarted, the worker crashed, or the run ended without telling
// us. Live runs are left alone, however long they have been quiet.
export async function deadAgentRuns(
  stories: readonly UserStory[],
  live: (sessionId: string) => Promise<boolean>,
  options: { now?: number; skip?: ReadonlySet<string> } = {}
) {
  const now = options.now ?? Date.now()
  const candidates = stories.flatMap((story) => {
    if (options.skip?.has(story.id)) return []
    const run = runningAgentRunsForStory(story).findLast(
      (item) => !item.finalResponse && runAge(item, now) >= deadSessionGraceMs
    )
    const sessionId = run?.clineSessionId ?? story.clineSessionId
    return run && sessionId ? [{ run, sessionId, story }] : []
  })
  const checked = await Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      live: await live(candidate.sessionId).catch(() => true),
    }))
  )
  return checked
    .filter((candidate) => !candidate.live)
    .map(({ run, story }) => ({ run, story }))
}

function runAge(run: UserStoryAgentRun, now: number) {
  const updatedAt = Date.parse(run.updatedAt ?? run.createdAt)
  return Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : Infinity
}
