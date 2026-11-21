// What the helper agents card shows, from the lead's `run_agents` call and
// the records of each helper's own session. Pure functions: the card and its
// thread dialog only draw what these return.

import type {
  RunAgentsInput,
  RunAgentsResult,
  SubAgentBrief,
  SubAgentReport,
  SubAgentResult,
  SubAgentRole,
} from "@blame/engine-client"
import type { Transcript } from "@blame/engine-client/transcript"

import {
  describeToolCall,
  toolCallSource,
} from "../tool-calls/describe-tool-call.ts"
import { formatDuration as formatElapsed } from "../tool-calls/tool-call-values.ts"
import { helperIdentity, type HelperIdentity } from "./helper-identity.ts"

export const runAgentsTool = "run_agents"

export type SubAgentStatus =
  "waiting" | "running" | "done" | "failed" | "cancelled"

export type SubAgentRow = {
  index: number
  role: SubAgentRole
  title: string
  /** What the lead asked it, in full. */
  brief: string
  status: SubAgentStatus
  /** The helper's own session, whose records are its thread. */
  session: string
  /** Its face and its name. */
  identity: HelperIdentity
  /** What it is doing now, as a sentence: only for a helper that runs. */
  current?: string
  tokens: number
  durationMs: number
  report?: SubAgentReport
  /** Why it did not finish. */
  reason?: string
}

/** The lead's call, as the card reads it. */
export type SubAgentsCall = {
  call: string
  briefs: SubAgentBrief[]
  /** The call has not returned: helpers are working or waiting. */
  running: boolean
  result?: RunAgentsResult
  /** Helpers waiting for a slot, as the call last reported. */
  queued: number[]
}

/** The session of the helper at `index` of `call` (the engine's naming). */
export function subAgentSession(call: string, index: number) {
  return `${call}.${index}`
}

type CallActivity = {
  detail: string
  status?: string
  toolCallId?: string
}

/**
 * The card's view of a `run_agents` call, or `undefined` when the call is
 * not one the card can show: its input was refused, or the engine refused
 * the call (ultra mode off) and there is no helper to show. Those calls show
 * as an ordinary step.
 */
export function readSubAgentsCall(
  activity: CallActivity
): SubAgentsCall | undefined {
  if (!activity.toolCallId) return undefined
  const detail = parse(activity.detail)
  const briefs = briefsOf(detail.input)
  if (!briefs) return undefined
  const running = activity.status === "running"
  const result = resultOf(detail.output)
  if (!running && !result) return undefined
  return {
    call: activity.toolCallId,
    briefs,
    running,
    ...(result ? { result } : {}),
    queued: queuedOf(detail.update),
  }
}

export function subAgentRows(
  call: SubAgentsCall,
  threads: ReadonlyMap<number, Transcript | undefined>,
  now: number
): SubAgentRow[] {
  return call.briefs.map((brief, index) => {
    const base = {
      index,
      role: brief.role,
      title: brief.title,
      brief: brief.brief,
      session: subAgentSession(call.call, index),
      identity: helperIdentity(call.call, index),
    }
    const result = call.result?.agents.find((agent) => agent.index === index)
    if (result) return { ...base, ...settled(result) }
    if (!call.running)
      // The call ended with no word of this helper.
      return {
        ...base,
        status: "cancelled" as const,
        tokens: 0,
        durationMs: 0,
      }
    return {
      ...base,
      ...live(threads.get(index), call.queued.includes(index), now),
    }
  })
}

function settled(result: SubAgentResult) {
  return {
    status: statusOf(result.status),
    tokens: result.tokens,
    durationMs: result.duration_ms,
    ...(result.report ? { report: result.report } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  }
}

function statusOf(status: SubAgentResult["status"]): SubAgentStatus {
  return status === "completed"
    ? "done"
    : status === "failed"
      ? "failed"
      : "cancelled"
}

/**
 * What the helper last did, as a sentence ("Searching "registerRoutes""),
 * from its own records.
 */
export function currentStep(thread: Transcript): string | undefined {
  const call = [...thread.items]
    .reverse()
    .find((item) => item.kind === "tool_call" && item.name !== "report")
  if (call?.kind !== "tool_call") return undefined
  const running = call.state === "requested" || call.state === "running"
  const view = describeToolCall(
    toolCallSource(
      {
        kind: "tool",
        title: call.name,
        toolName: call.name,
        detail: JSON.stringify({ toolName: call.name, input: call.input }),
      },
      running
    )
  )
  return [view.verb, view.target?.text].filter(Boolean).join(" ")
}

/** A helper still going, from its own records. */
function live(thread: Transcript | undefined, queued: boolean, now: number) {
  const turn = thread?.turns[0]
  if (!thread || !turn)
    return {
      status: queued ? ("waiting" as const) : ("running" as const),
      tokens: 0,
      durationMs: 0,
    }
  const tokens = threadTokens(thread)
  const durationMs = Math.max(0, (turn.endedAtMs ?? now) - turn.startedAtMs)
  if (turn.status === "running" || turn.status === "queued") {
    return {
      status: "running" as const,
      tokens,
      durationMs,
      current: currentStep(thread) ?? "Thinking",
    }
  }
  // Ended, and the lead's call has not reported yet.
  return {
    status:
      turn.status === "completed"
        ? ("done" as const)
        : turn.status === "interrupted"
          ? ("cancelled" as const)
          : ("failed" as const),
    tokens,
    durationMs,
  }
}

/** Tokens of every reply of a thread: input, cache reads and writes, output. */
export function threadTokens(thread: Transcript) {
  const total = thread.usage.spent
  return (
    total.inputTokens +
    total.outputTokens +
    total.cacheReadTokens +
    total.cacheWriteTokens
  )
}

export type SubAgentTotals = {
  tokens: number
  /** Helpers run side by side: the longest one is the wait. */
  durationMs: number
  done: number
  failed: number
  /** Stopped before they reported (the turn was interrupted). */
  stopped: number
  count: number
}

export function subAgentTotals(rows: readonly SubAgentRow[]): SubAgentTotals {
  return {
    tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    durationMs: rows.reduce(
      (longest, row) => Math.max(longest, row.durationMs),
      0
    ),
    done: rows.filter((row) => row.status === "done").length,
    failed: rows.filter((row) => row.status === "failed").length,
    stopped: rows.filter((row) => row.status === "cancelled").length,
    count: rows.length,
  }
}

export const statusLabels: Record<SubAgentStatus, string> = {
  waiting: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
}

export const roleLabels: Record<SubAgentRole, string> = {
  explore: "Explore",
  research: "Research",
  review: "Review",
}

/** `1.2k`, `38k`, `1.4M`: tokens at a glance. */
export function formatTokens(tokens: number) {
  if (tokens < 1000) return String(tokens)
  if (tokens < 10_000)
    return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

/** `<1 s`, `0.8 s`, `38 s`, `2 min 5 s`. */
export function formatDuration(ms: number) {
  return ms < 1000 ? "<1 s" : (formatElapsed(ms) ?? "")
}

/**
 * The sentence that opens the helpers of a call, like the sentence of any
 * step of the work: "Running 3 helpers · 1 done", "Ran 3 helpers · 1 failed".
 * A helper that failed or was stopped is said so, never counted as one still
 * to come.
 */
export function leadIn(totals: SubAgentTotals, running: boolean) {
  const lost = [
    totals.failed ? `${totals.failed} failed` : "",
    totals.stopped ? `${totals.stopped} stopped` : "",
  ].filter(Boolean)
  const progress = running && totals.done > 0 ? [`${totals.done} done`] : []
  return {
    verb: running ? "Running" : "Ran",
    target: `${totals.count} ${totals.count === 1 ? "helper" : "helpers"}`,
    rest: [...progress, ...lost].join(" · "),
  }
}

/**
 * Why the engine did not start a call, when it did not (ultra mode off for
 * the message, a role the conversation cannot serve): its first sentence, for
 * the person. `undefined` for a call that did start helpers or is not over.
 */
export function readSubAgentsRefusal(activity: CallActivity) {
  if (!activity.toolCallId || activity.status === "running") return undefined
  const output = parse(activity.detail).output
  if (typeof output !== "string") return undefined
  const sentence = output
    .replace(/^Not started:\s*/u, "")
    .split(/(?<=\.)\s/u)[0]
    ?.trim()
  return sentence ? sentence[0]!.toUpperCase() + sentence.slice(1) : undefined
}

function parse(detail: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(detail)
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function briefsOf(input: unknown): SubAgentBrief[] | undefined {
  const agents = (input as Partial<RunAgentsInput> | undefined)?.agents
  if (!Array.isArray(agents) || agents.length === 0) return undefined
  const briefs: SubAgentBrief[] = []
  for (const agent of agents as Partial<SubAgentBrief>[]) {
    if (
      !agent ||
      !isRole(agent.role) ||
      typeof agent.title !== "string" ||
      typeof agent.brief !== "string"
    )
      return undefined
    briefs.push({ role: agent.role, title: agent.title, brief: agent.brief })
  }
  return briefs
}

function isRole(role: unknown): role is SubAgentRole {
  return role === "explore" || role === "research" || role === "review"
}

function resultOf(output: unknown): RunAgentsResult | undefined {
  const agents = (output as Partial<RunAgentsResult> | undefined)?.agents
  return Array.isArray(agents) ? (output as RunAgentsResult) : undefined
}

function queuedOf(update: unknown): number[] {
  if (typeof update !== "string") return []
  try {
    const queued = (JSON.parse(update) as { queued?: unknown }).queued
    return Array.isArray(queued)
      ? queued.filter((index): index is number => typeof index === "number")
      : []
  } catch {
    return []
  }
}
