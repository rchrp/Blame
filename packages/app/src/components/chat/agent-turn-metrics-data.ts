import type { TurnActivity } from "./tool-calls/turn-changes.ts"

export type AgentTurnMetricRun = {
  activities?: readonly TurnActivity[] | null
  checkpointRunCount?: number | null
  clineSessionId?: string | null
  completedAt?: string | null
  diffEndRef?: string | null
  createdAt: string
  id: string
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
  updatedAt?: string | null
}

export type AgentTurnMetrics = {
  additions: number
  deletions: number
  elapsedMs: number
  running: boolean
}

export function latestLinkedAgentTurn<
  Message extends { createdAt: string; id: string },
  Run extends AgentTurnMetricRun,
>(
  messages: readonly Message[],
  runs: readonly Run[],
  messageIdForRun: (run: Run) => string | null | undefined
) {
  const message = latestMessage(messages)
  if (!message) return undefined
  const run = runs.findLast(
    (candidate) => messageIdForRun(candidate) === message.id
  )
  return run ? { message, run } : undefined
}

export function agentTurnMetricsTarget<
  Message extends { createdAt: string; id: string },
  Run extends AgentTurnMetricRun,
>(
  messages: readonly Message[],
  runs: readonly Run[],
  messageIdForRun: (run: Run) => string | null | undefined
) {
  const linkedTurn = latestLinkedAgentTurn(messages, runs, messageIdForRun)
  if (linkedTurn) {
    return { run: linkedTurn.run, startedAt: linkedTurn.message.createdAt }
  }
  if (messages.length) return undefined
  const run = latestMessage(runs)
  return run ? { run, startedAt: run.createdAt } : undefined
}

export function formatAgentTurnDuration(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

export function agentTurnElapsedTime(
  run: AgentTurnMetricRun,
  startedAt: string,
  currentTime: number
) {
  const start = validTimestamp(startedAt, currentTime)
  if (run.status === "running") return Math.max(0, currentTime - start)
  const end = validTimestamp(
    run.completedAt ?? run.updatedAt ?? run.createdAt,
    start
  )
  return Math.max(0, end - start)
}

function validTimestamp(timestamp: string, fallback: number) {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : fallback
}

function latestMessage<Message extends { createdAt: string }>(
  messages: readonly Message[]
) {
  return messages.reduce<Message | undefined>((latest, message) => {
    if (!latest || message.createdAt >= latest.createdAt) return message
    return latest
  }, undefined)
}
