import type {
  ModelRecommendation,
  ModelRecommendations,
} from "@blame/agent-runtime"

import type { EpicModelKey } from "@/components/orchestrator/data/epic-data"

// The models an epic's stories may run on, ranked the way the engine host
// ranks them when it turns an intent into a model
// (`packages/agent-runtime/src/engine/model-intent.ts`): the benchmarked,
// visible models of the allowed providers, cheapest first, at i / (n - 1).
// The settings' range slider puts its notches on these positions, so a
// handle set on a notch is the slice the host reads. The host's module is
// not exported to the app; this mirrors its ranking and its intent choice.

export type ModelIntent = "cheaper" | "balanced" | "smarter"

export type RankedModel = ModelRecommendation & { rank: number }

export const modelIntents: readonly ModelIntent[] = [
  "cheaper",
  "balanced",
  "smarter",
]

export const modelIntentLabels: Record<ModelIntent, string> = {
  cheaper: "Cheaper",
  balanced: "Balanced",
  smarter: "Smarter",
}

const tolerance = 1e-9

export function rankedEpicModels(input: {
  recommendations: Pick<ModelRecommendations, "all" | "byProvider"> | undefined
  providers?: readonly string[]
  hidden?: readonly EpicModelKey[]
}): RankedModel[] {
  if (!input.recommendations) return []
  const sorted = sourceList(input).sort(compare)
  return sorted.map((item, index) => ({
    ...item,
    rank: sorted.length === 1 ? 0.5 : index / (sorted.length - 1),
  }))
}

/** The ranked models inside the range; the nearest one when none is. */
export function modelsInRange(
  ranked: readonly RankedModel[],
  range: { min: number; max: number }
) {
  if (!ranked.length) return []
  const inside = ranked.filter(
    (item) =>
      item.rank >= range.min - tolerance && item.rank <= range.max + tolerance
  )
  if (inside.length) return inside
  const distance = (item: RankedModel) =>
    Math.max(range.min - item.rank, item.rank - range.max)
  return [
    ranked.reduce((best, item) =>
      distance(item) < distance(best) ? item : best
    ),
  ]
}

/** What each intent would pick inside the range now. */
export function intentModels(
  ranked: readonly RankedModel[],
  range: { min: number; max: number }
): Record<ModelIntent, RankedModel> | undefined {
  const inRange = modelsInRange(ranked, range)
  if (!inRange.length) return undefined
  return {
    cheaper: inRange[0]!,
    balanced: inRange[Math.floor((inRange.length - 1) / 2)]!,
    smarter: inRange[inRange.length - 1]!,
  }
}

function sourceList(input: Parameters<typeof rankedEpicModels>[0]) {
  const recommendations = input.recommendations!
  const hidden = input.hidden ?? []
  const allowed = [...new Set(input.providers ?? [])]
  const visible = (items: readonly ModelRecommendation[]) =>
    items.filter(
      (item) =>
        item.segment === "benchmarked" &&
        !hidden.some((entry) => sameModel(entry, item))
    )
  if (!allowed.length) return visible(recommendations.all)
  if (allowed.length === 1)
    return visible(recommendations.byProvider[allowed[0]!] ?? [])
  const union = new Map<string, ModelRecommendation>()
  for (const providerId of allowed)
    for (const item of visible(recommendations.byProvider[providerId] ?? []))
      union.set(`${item.providerId}\n${item.modelId}`, item)
  const items = [...union.values()]
  return items.filter((item) => !items.some((other) => dominates(other, item)))
}

function dominates(left: ModelRecommendation, right: ModelRecommendation) {
  return (
    cost(left) <= cost(right) &&
    score(left) >= score(right) &&
    (cost(left) < cost(right) || score(left) > score(right))
  )
}

function compare(left: ModelRecommendation, right: ModelRecommendation) {
  return (
    cost(left) - cost(right) ||
    score(left) - score(right) ||
    left.providerId.localeCompare(right.providerId) ||
    left.modelId.localeCompare(right.modelId)
  )
}

function cost(item: ModelRecommendation) {
  return item.estimatedCost ?? Number.POSITIVE_INFINITY
}

function score(item: ModelRecommendation) {
  return item.smartScore ?? Number.NEGATIVE_INFINITY
}

function sameModel(left: EpicModelKey, right: EpicModelKey) {
  return left.providerId === right.providerId && left.modelId === right.modelId
}
