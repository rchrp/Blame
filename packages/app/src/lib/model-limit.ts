// A model that cannot answer until something changes: the plan's usage is
// used up until it resets (a Claude or ChatGPT subscription), or the API
// key has no credit left. The engine words both (crates/blame-engine-
// providers/src/error.rs); a task's failure adds when the plan resets
// (agent-runtime engine/tasks/runner.ts). Only the app knows which setting
// picked the model, so it writes the one message the person reads.

import type { ErrorInfo } from "@blame/engine-client"

export type ModelLimit = {
  kind: "usage_limit" | "billing"
  provider: string
  model: string
  /** The provider's own words. */
  said: string
  resetsAt?: Date
}

/**
 * Where the model that hit the limit is chosen: the Alternative model for
 * the app's own tasks (analyses, setup, git texts), the conversation's
 * model menu for stories, quick chats and plans.
 */
export type ModelLimitSetting = "alternative" | "conversation"

const usagePattern =
  /Your (.+?) usage for `([^`]+)` is used up until it resets: "([\s\S]*)"\./u
const creditPattern =
  /(?:^|: )([^:]+?) has no credit or quota left for `([^`]+)`: "([\s\S]*)"\./u
const resetPattern = /It resets at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\./u

/** The limit a failure's text reports, if it is one. */
export function modelLimit(text: string | null | undefined): ModelLimit | undefined {
  if (!text) return undefined
  const usage = usagePattern.exec(text)
  if (usage) {
    const reset = resetPattern.exec(text)
    const resetsAt = reset ? new Date(reset[1]!) : undefined
    return {
      kind: "usage_limit",
      provider: usage[1]!,
      model: usage[2]!,
      said: usage[3]!,
      ...(resetsAt && Number.isFinite(resetsAt.getTime()) ? { resetsAt } : {}),
    }
  }
  const credit = creditPattern.exec(text)
  if (!credit) return undefined
  return { kind: "billing", provider: credit[1]!.trim(), model: credit[2]!, said: credit[3]! }
}

/** The limit a conversation's request failed on; `atMs` is when it failed. */
export function modelLimitOfError(error: ErrorInfo, atMs: number): ModelLimit | undefined {
  if (error.kind !== "usage_limit" && error.kind !== "billing") return undefined
  const limit = modelLimit(error.message)
  if (!limit) return undefined
  return typeof error.retry_after_ms === "number" && error.retry_after_ms > 0
    ? { ...limit, resetsAt: new Date(atMs + error.retry_after_ms) }
    : limit
}

export const alternativeModelSetting = "Settings → Models & Providers → Alternative model"
export const agentModelSetting = "Settings → Models & Providers → Agent model"

/** The one message the person reads about a limit. */
export function modelLimitText(
  limit: ModelLimit,
  setting: ModelLimitSetting,
  now = new Date()
) {
  const where =
    setting === "alternative"
      ? `in ${alternativeModelSetting}`
      : `in the message box's model menu (the default is ${agentModelSetting})`
  const said = `${limit.provider} said: “${limit.said}”.`
  if (limit.kind === "billing")
    return `${limit.provider} has no credit left for \`${limit.model}\`. ${said} Add credit with ${limit.provider}, or choose another model ${where}.`
  const resets = limit.resetsAt ? ` It resets ${resetTime(limit.resetsAt, now)}.` : ""
  return `Your ${limit.provider} usage for \`${limit.model}\` is used up.${resets} ${said} To keep going now, choose another model ${where}.`
}

/** A short title for the limit. */
export function modelLimitTitle(limit: ModelLimit) {
  return limit.kind === "billing" ? "No credit left" : "Usage limit reached"
}

/** The person's own words for a failure: the limit's message when it is one. */
export function failureMessage(text: string, setting: ModelLimitSetting) {
  const limit = modelLimit(text)
  return limit ? modelLimitText(limit, setting) : text
}

function resetTime(at: Date, now: Date) {
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  if (at.toDateString() === now.toDateString()) return `at ${time}`
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`
  const day = at.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
  return `on ${day} at ${time}`
}

/**
 * Whether the app may run a task by itself again after this failure: not
 * with the same model before its plan resets. Without a stated reset (an
 * account out of credit, a Claude Code message without a time) it waits
 * `unknownResetMs` from the failure: one try an hour, not one a minute.
 */
export function limitAllowsAutomaticRun(input: {
  error: string | null | undefined
  failedAt: number
  failedModel: { providerId: string | null; modelId: string | null }
  model: { providerId: string; modelId: string }
  now?: number
}) {
  const limit = modelLimit(input.error)
  if (!limit) return true
  if (
    input.failedModel.providerId !== input.model.providerId ||
    input.failedModel.modelId !== input.model.modelId
  )
    return true
  const now = input.now ?? Date.now()
  const until = limit.resetsAt?.getTime() ?? input.failedAt + unknownResetMs
  return now >= until
}

export const unknownResetMs = 60 * 60_000
