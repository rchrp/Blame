import * as React from "react"

import { turnChanges } from "./tool-calls/turn-changes"
import {
  agentTurnElapsedTime,
  type AgentTurnMetricRun,
  type AgentTurnMetrics,
} from "./agent-turn-metrics-data"

export {
  agentTurnMetricsTarget,
  formatAgentTurnDuration,
  latestLinkedAgentTurn,
  type AgentTurnMetrics,
} from "./agent-turn-metrics-data"

// Duration and line counts of the latest turn. Line counts come from the
// turn's own tool calls, like the end-of-turn summary, so the composer and
// the conversation always agree (the story's total diff comes from git).
export function useAgentTurnMetrics({
  run,
  startedAt,
}: {
  root?: string | null
  run?: AgentTurnMetricRun
  startedAt?: string
}): AgentTurnMetrics | undefined {
  const [currentTime, setCurrentTime] = React.useState(Date.now)
  const activities = run?.activities
  const changes = React.useMemo(
    () => (activities ? turnChanges(activities) : undefined),
    [activities]
  )
  useCurrentTime(run, setCurrentTime)

  if (!run || !startedAt) return undefined
  return {
    additions: changes?.additions ?? 0,
    deletions: changes?.deletions ?? 0,
    elapsedMs: agentTurnElapsedTime(run, startedAt, currentTime),
    running: run.status === "running",
  }
}

function useCurrentTime(
  run: AgentTurnMetricRun | undefined,
  setCurrentTime: React.Dispatch<React.SetStateAction<number>>
) {
  React.useEffect(() => {
    if (run?.status !== "running") return
    setCurrentTime(Date.now())
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [run?.id, run?.status, setCurrentTime])
}
