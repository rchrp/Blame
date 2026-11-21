// A model that cannot answer until something changes: the plan's usage is
// used up until it resets (a Claude or ChatGPT subscription), or the API
// key has no credit left. The engine words both (crates/blame-engine-
// providers/src/error.rs); a task's failure adds when the plan resets
// (agent-runtime engine/tasks/runner.ts). Only the app knows which setting
// picked the model, so it writes the one message the person reads.

import type { ErrorInfo } from "@blame/engine-client"
import { usageResetAt } from "@blame/engine-client/usage-reset"

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
const resetPattern =
  /It resets at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\./u

/** The limit a failure's text reports, if it is one. */
export function modelLimit(
  text: string | null | undefined
): ModelLimit | undefined {
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
  return {
    kind: "billing",
    provider: credit[1]!.trim(),
    model: credit[2]!,
    said: credit[3]!,
  }
}

/** The limit a conversation's request failed on; `atMs` is when it failed. */
export function modelLimitOfError(
  error: ErrorInfo,
  atMs: number
): ModelLimit | undefined {
  if (error.kind !== "usage_limit" && error.kind !== "billing") return undefined
  const limit = modelLimit(error.message)
  if (!limit || limit.kind === "billing") return limit
  // The provider's delay, or the time Claude Code states in its words.
  const resetsAt = usageResetAt(error, atMs)
  return resetsAt ? { ...limit, resetsAt } : limit
}

export const alternativeModelSetting =
  "Settings › Models & Providers › Alternative model"

/**
 * The one message the person reads about a limit, short: which model, until
 * when, and where to pick another. The provider's own words only when they
 * say more than that (no reset time known).
 */
export function modelLimitText(
  limit: ModelLimit,
  setting: ModelLimitSetting,
  now = new Date()
) {
  const where =
    setting === "alternative"
      ? `pick another Alternative model in Settings › Models & Providers`
      : "pick another model in the message box"
  if (limit.kind === "billing")
    return `${limit.provider} has no credit left for ${limit.model}. Add credit, or ${where}.`
  return `${modelLimitSummary(limit, now)} To keep going now, ${where}.`
}

/** "gpt-6-luna is used up until 4:19." (the provider's words when no time is known). */
export function modelLimitSummary(limit: ModelLimit, now = new Date()) {
  if (limit.kind === "billing")
    return `${limit.provider} has no credit left for ${limit.model}.`
  if (limit.resetsAt)
    return `${limit.model} is used up until ${resetTime(limit.resetsAt, now)}.`
  return `${limit.model} is used up for now (${limit.provider}: “${limit.said.replace(/\s*\(HTTP \d+\)$/u, "")}”).`
}

/** A short title for the limit. */
export function modelLimitTitle(limit: ModelLimit) {
  return limit.kind === "billing"
    ? `No ${limit.provider} credit left`
    : `${limit.provider} usage limit reached`
}

/** The person's own words for a failure: the limit's message when it is one. */
export function failureMessage(text: string, setting: ModelLimitSetting) {
  const limit = modelLimit(text)
  return limit ? modelLimitText(limit, setting) : text
}

function resetTime(at: Date, now: Date) {
  const time = at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
  if (at.toDateString() === now.toDateString()) return time
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow, ${time}`
  const day = at.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  })
  return `${day}, ${time}`
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
