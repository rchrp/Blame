import type {
  ModelRecommendation,
  ReasoningSelection,
} from "@blame/agent-runtime"

// Picks the two default models for someone who has just connected a provider,
// from the same ranking Smart Selection shows (the API's Pareto frontier of
// estimated cost against the Artificial Analysis Intelligence Index). Pure:
// the onboarding screen passes the recommendations it already has.

/**
 * The alternative model (project setup, titles, security audits) is the
 * cheapest frontier model scoring at least this share of the agent model.
 *
 * Measured on the Intelligence Index of the current catalog (top score 64.6),
 * 0.4 puts the floor at about 26: the small tier of the major labs stays
 * eligible (Claude Haiku 5.5 at 36.5, Gemini 3.8 Flash at 30.8, GPT-6 Luna at
 * 27.9) while the tiny and previous-generation ones drop out (Gemini 3.5 Flash
 * Lite at 11.7, Claude Haiku 4.5 at 7.4, gpt-oss-120b at 3.8).
 *
 * It is a share of the top score, not a fixed number, because Artificial
 * Analysis rescales its index when it publishes a new version: a share keeps
 * its meaning, an absolute floor would suddenly exclude or admit everything.
 * The reference is the agent model picked from the connected providers, so
 * someone with a single modest provider still gets a cheap model that is not
 * much weaker than their agent.
 */
export const alternativeFloorRatio = 0.4

/**
 * The agent model is the smartest model whose output price, in dollars per
 * million tokens, is at most this. The very top tier (Claude Fable 5.2 at $40)
 * costs too much to run as the everyday coding agent, while the tier below it
 * (Claude Opus 5.5 at $20, and the flagships of the other labs) is what people
 * expect to start with. A model without a known output price is not excluded.
 */
export const agentOutputPriceCap = 30

export type AutoModelCandidate<Model> = ModelRecommendation & {
  model: Model
  /** Output price in dollars per million tokens, when known. */
  outputPrice?: number | null
}

export type AutoModelChoice<Model> = {
  agent: Model
  alternative: Model
  /** Reasoning effort to start each model with; `undefined` is the model's own default. */
  agentVariant: ReasoningSelection | undefined
  alternativeVariant: ReasoningSelection | undefined
  /** `frontier`: ranked by Smart Selection. `fallback`: nothing was scored, the provider's default model stands in. */
  source: "frontier" | "fallback"
}

/**
 * The agent model is the smartest of the frontier within the output price
 * cap, and the cheapest of the frontier when every model is above it. The
 * alternative is the cheapest frontier model scoring at least the floor share
 * of the agent model, and the agent model itself when none does. A model without an Intelligence Index is never picked, since
 * the floor cannot be checked on it; only when no model at all is scored (the
 * ranking is unavailable, or the provider has unbenchmarked models only, like
 * an OpenAI-compatible server) does `fallback` stand in for both, so setup can
 * still finish. Without a fallback either, there is no choice.
 */
export function chooseAutoModels<Model>(
  candidates: AutoModelCandidate<Model>[],
  fallback?: Model,
  floorRatio = alternativeFloorRatio,
  priceCap = agentOutputPriceCap
): AutoModelChoice<Model> | undefined {
  const frontier = withoutDominated(candidates.filter(scored))
  const affordable = frontier.filter((candidate) =>
    withinCap(candidate, priceCap)
  )
  const agent =
    affordable.length > 0
      ? [...affordable].sort(bySmartest)[0]
      : [...frontier].sort(byCheapest)[0]
  if (!agent) {
    if (fallback === undefined) return undefined
    return {
      agent: fallback,
      alternative: fallback,
      agentVariant: undefined,
      alternativeVariant: undefined,
      source: "fallback",
    }
  }
  const floor = agent.smartScore! * floorRatio
  const cheapest = frontier
    .filter((candidate) => candidate.smartScore! >= floor)
    .sort(byCheapest)[0]
  const alternative = cheapest ?? agent
  return {
    agent: agent.model,
    alternative: alternative.model,
    // Both keep the model's own reasoning default, which its maker tuned:
    // the alternative is already the cheap model, and lowering its effort
    // on top of that made its work (project setup, audits) noticeably worse.
    agentVariant: undefined,
    alternativeVariant: undefined,
    source: "frontier",
  }
}

function withinCap(candidate: AutoModelCandidate<unknown>, cap: number) {
  const price = candidate.outputPrice
  return typeof price !== "number" || !Number.isFinite(price) || price <= cap
}

/** The effort to save for a model: the wanted one when the model offers it. */
export function supportedVariant(
  variants: Record<string, unknown> | undefined,
  wanted: ReasoningSelection | undefined
): ReasoningSelection | null {
  return wanted && variants?.[wanted] ? wanted : null
}

function scored(candidate: AutoModelCandidate<unknown>) {
  return (
    candidate.segment === "benchmarked" &&
    typeof candidate.smartScore === "number" &&
    Number.isFinite(candidate.smartScore) &&
    typeof candidate.estimatedCost === "number" &&
    Number.isFinite(candidate.estimatedCost)
  )
}

// Same rule as the API's `dominates`: no dearer, no less smart, and strictly
// better on one of the two. Equals stay: neither removes the other.
function withoutDominated<Model>(candidates: AutoModelCandidate<Model>[]) {
  return candidates.filter(
    (candidate) => !candidates.some((other) => dominates(other, candidate))
  )
}

function dominates(
  left: AutoModelCandidate<unknown>,
  right: AutoModelCandidate<unknown>
) {
  const cheaper = left.estimatedCost! < right.estimatedCost!
  const smarter = left.smartScore! > right.smartScore!
  return (
    left.estimatedCost! <= right.estimatedCost! &&
    left.smartScore! >= right.smartScore! &&
    (cheaper || smarter)
  )
}

// Ties end on the ids, so the same list always gives the same choice.
function bySmartest(
  left: AutoModelCandidate<unknown>,
  right: AutoModelCandidate<unknown>
) {
  return (
    right.smartScore! - left.smartScore! ||
    left.estimatedCost! - right.estimatedCost! ||
    byIds(left, right)
  )
}

function byCheapest(
  left: AutoModelCandidate<unknown>,
  right: AutoModelCandidate<unknown>
) {
  return (
    left.estimatedCost! - right.estimatedCost! ||
    right.smartScore! - left.smartScore! ||
    byIds(left, right)
  )
}

function byIds(left: ModelRecommendation, right: ModelRecommendation) {
  return (
    left.providerId.localeCompare(right.providerId) ||
    left.modelId.localeCompare(right.modelId)
  )
}
