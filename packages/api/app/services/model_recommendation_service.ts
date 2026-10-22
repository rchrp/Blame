import type {
  CatalogModel,
  CatalogProvider,
  ModelRecommendation,
  ModelRecommendationProfile,
  ModelRecommendations,
} from '#services/model_catalog_contract'

type RecommendationCandidate = {
  providerId: string
  model: CatalogModel
  estimatedCost: number | null
}

const benchmarkBoundary = 0.74
const unbenchmarkedStart = 0.8
const newModelWindowDays = 90

export function buildModelRecommendations(
  providers: CatalogProvider[],
  connectedProviderIds: string[],
  profile: ModelRecommendationProfile,
  generatedAt: string
): ModelRecommendations {
  const connected = new Set(connectedProviderIds)
  const candidates = providers
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) => providerCandidates(provider, profile))
  const byProvider = Object.fromEntries(
    connectedProviderIds.map((providerId) => [
      providerId,
      recommendationEntries(
        candidates.filter((entry) => entry.providerId === providerId),
        generatedAt
      ),
    ])
  )
  return {
    generatedAt,
    benchmarkBoundary,
    all: recommendationEntries(deduplicateCanonicalModels(candidates), generatedAt),
    byProvider,
    profile,
  }
}

function providerCandidates(provider: CatalogProvider, profile: ModelRecommendationProfile) {
  return Object.values(provider.models)
    .filter((model) => model.status !== 'deprecated')
    .map((model) => ({
      providerId: provider.id,
      model,
      estimatedCost: estimateModelCost(model, profile),
    }))
}

function recommendationEntries(candidates: RecommendationCandidate[], generatedAt: string) {
  const benchmarked = paretoFrontier(candidates.filter(hasBenchmark))
  const unbenchmarked = candidates.filter(
    (candidate) => !hasBenchmark(candidate) && recentlyReleased(candidate.model, generatedAt)
  )
  const ranked = benchmarked.sort(compareBenchmarked)
  const unrated = unbenchmarked.sort(compareCost)
  return [
    ...positionedEntries(ranked, 0, benchmarkBoundary, 'benchmarked'),
    ...positionedEntries(unrated, unbenchmarkedStart, 1, 'unbenchmarked'),
  ]
}

function recentlyReleased(model: CatalogModel, generatedAt: string) {
  const release = releaseTime(model.releaseDate)
  const generated = releaseTime(generatedAt)
  if (!release || !generated) return false
  return release >= generated - newModelWindowDays * 24 * 60 * 60 * 1000
}

function paretoFrontier(candidates: RecommendationCandidate[]) {
  return candidates.filter((candidate) => !candidates.some((other) => dominates(other, candidate)))
}

function dominates(left: RecommendationCandidate, right: RecommendationCandidate) {
  if (left === right) return false
  const leftScore = comparableScore(left.model) ?? -Infinity
  const rightScore = comparableScore(right.model) ?? -Infinity
  const costComparison = comparableCost(left.estimatedCost) <= comparableCost(right.estimatedCost)
  const scoreComparison = leftScore >= rightScore
  const strict =
    leftScore > rightScore ||
    comparableCost(left.estimatedCost) < comparableCost(right.estimatedCost)
  return costComparison && scoreComparison && strict
}

function positionedEntries(
  candidates: RecommendationCandidate[],
  start: number,
  end: number,
  segment: ModelRecommendation['segment']
) {
  return candidates.map((candidate, index) =>
    recommendationEntry(candidate, position(index, candidates.length, start, end), segment)
  )
}

function recommendationEntry(
  candidate: RecommendationCandidate,
  positionValue: number,
  segment: ModelRecommendation['segment']
): ModelRecommendation {
  return {
    providerId: candidate.providerId,
    modelId: candidate.model.id,
    position: positionValue,
    segment,
    estimatedCost: candidate.estimatedCost,
    smartScore: comparableScore(candidate.model),
  }
}

function deduplicateCanonicalModels(candidates: RecommendationCandidate[]) {
  const unique = new Map<string, RecommendationCandidate>()
  for (const candidate of candidates) {
    const key = candidate.model.canonicalModelId ?? `${candidate.providerId}:${candidate.model.id}`
    const current = unique.get(key)
    if (!current || compareCost(candidate, current) < 0) unique.set(key, candidate)
  }
  return [...unique.values()]
}

function estimateModelCost(model: CatalogModel, profile: ModelRecommendationProfile) {
  const input = pricedTokens(model.cost.input, profile.inputTokens)
  const output = pricedTokens(model.cost.output, profile.outputTokens)
  const cacheRead = pricedTokens(model.cost.cacheRead, profile.cacheReadTokens)
  const values = [input, output, cacheRead].filter((value): value is number => value !== null)
  return values.length ? round(values.reduce((sum, value) => sum + value, 0)) : null
}

function pricedTokens(price: number | null, tokens: number) {
  if (price === null) return null
  return (price * tokens) / 1_000_000
}

function hasBenchmark(candidate: RecommendationCandidate) {
  return comparableScore(candidate.model) !== undefined
}

// Models are ranked on one scale only: the Artificial Analysis
// Intelligence Index. Nearly every rated model has it, brand-new ones
// included, while coding and agentic indexes often come weeks later. Mixing
// scales would misplace models, so a model without it joins the new ones.
function comparableScore(model: CatalogModel) {
  return model.benchmark?.intelligenceIndex
}

function compareBenchmarked(left: RecommendationCandidate, right: RecommendationCandidate) {
  return (
    comparableCost(left.estimatedCost) - comparableCost(right.estimatedCost) ||
    (comparableScore(left.model) ?? 0) - (comparableScore(right.model) ?? 0)
  )
}

function compareCost(left: RecommendationCandidate, right: RecommendationCandidate) {
  return (
    comparableCost(left.estimatedCost) - comparableCost(right.estimatedCost) ||
    releaseTime(right.model.releaseDate) - releaseTime(left.model.releaseDate) ||
    left.model.name.localeCompare(right.model.name)
  )
}

function comparableCost(value: number | null) {
  return value ?? Number.POSITIVE_INFINITY
}

function releaseTime(value: string | undefined) {
  const parsed = value ? Date.parse(value) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function position(index: number, length: number, start: number, end: number) {
  if (length <= 1) return round((start + end) / 2)
  return round(start + (index / (length - 1)) * (end - start))
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000
}
