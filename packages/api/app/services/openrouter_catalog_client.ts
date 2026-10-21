import type { CatalogBenchmark, OpenRouterModel } from '#services/model_catalog_contract'

type BenchmarkAccumulator = {
  codingIndex?: number
  agenticIndex?: number
  intelligenceIndex?: number
  designArenaScores: number[]
}

export async function fetchOpenRouterCatalog(apiKey: string, fetcher: typeof fetch = fetch) {
  const [modelsPayload, benchmarksPayload] = await Promise.all([
    fetchOpenRouterJson('/models?output_modalities=text', apiKey, fetcher),
    fetchOpenRouterJson('/benchmarks', apiKey, fetcher).catch(() => ({ data: [] })),
  ])
  const benchmarks = benchmarkMap(benchmarksPayload)
  return payloadItems(modelsPayload)
    .map((value) => openRouterModel(value, benchmarks))
    .filter((model): model is OpenRouterModel => model !== undefined)
}

async function fetchOpenRouterJson(path: string, apiKey: string, fetcher: typeof fetch) {
  const response = await fetcher(`https://openrouter.ai/api/v1${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`OpenRouter request failed with status ${response.status}`)
  return response.json()
}

function openRouterModel(
  value: unknown,
  benchmarks: Map<string, CatalogBenchmark>
): OpenRouterModel | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined
  const canonicalSlug = stringValue(value.canonical_slug) ?? value.id
  const inlineBenchmark = benchmarkFromModel(value.benchmarks)
  return {
    id: value.id,
    canonicalSlug,
    name: stringValue(value.name) ?? value.id,
    contextWindow: numberValue(value.context_length),
    maxTokens: nestedNumber(value.top_provider, 'max_completion_tokens'),
    inputPrice: tokenPrice(value.pricing, 'prompt'),
    outputPrice: tokenPrice(value.pricing, 'completion'),
    cacheReadPrice: tokenPrice(value.pricing, 'input_cache_read'),
    cacheWritePrice: tokenPrice(value.pricing, 'input_cache_write'),
    releaseDate: releaseDate(value.created),
    benchmark: benchmarks.get(value.id) ?? benchmarks.get(canonicalSlug) ?? inlineBenchmark,
  }
}

function benchmarkMap(payload: unknown) {
  const accumulators = new Map<string, BenchmarkAccumulator>()
  for (const value of payloadItems(payload)) collectBenchmark(accumulators, value)
  return new Map(
    [...accumulators.entries()]
      .map(([id, value]) => [id, finalizeBenchmark(value)] as const)
      .filter((entry): entry is [string, CatalogBenchmark] => entry[1] !== undefined)
  )
}

function collectBenchmark(accumulators: Map<string, BenchmarkAccumulator>, value: unknown) {
  if (!isRecord(value) || typeof value.model_permaslug !== 'string') return
  const current = accumulators.get(value.model_permaslug) ?? { designArenaScores: [] }
  current.codingIndex ??= numberValue(value.coding_index)
  current.agenticIndex ??= numberValue(value.agentic_index)
  current.intelligenceIndex ??= numberValue(value.intelligence_index)
  const designScore = numberValue(value.win_rate)
  if (designScore !== undefined) current.designArenaScores.push(designScore)
  accumulators.set(value.model_permaslug, current)
}

function benchmarkFromModel(value: unknown) {
  if (!isRecord(value)) return undefined
  const artificial = isRecord(value.artificial_analysis) ? value.artificial_analysis : {}
  const accumulator: BenchmarkAccumulator = {
    codingIndex: numberValue(artificial.coding_index),
    agenticIndex: numberValue(artificial.agentic_index),
    intelligenceIndex: numberValue(artificial.intelligence_index),
    designArenaScores: designArenaScores(value.design_arena),
  }
  return finalizeBenchmark(accumulator)
}

function finalizeBenchmark(value: BenchmarkAccumulator): CatalogBenchmark | undefined {
  const designArenaScore = average(value.designArenaScores)
  // Keep raw dimensions for diagnostics; the selector ranks only intelligenceIndex.
  const smartScore =
    value.intelligenceIndex ?? value.codingIndex ?? value.agenticIndex ?? designArenaScore
  if (smartScore === undefined) return undefined
  return {
    smartScore,
    codingIndex: value.codingIndex,
    agenticIndex: value.agenticIndex,
    intelligenceIndex: value.intelligenceIndex,
    designArenaScore,
  }
}

function designArenaScores(value: unknown) {
  if (!Array.isArray(value)) return []
  const preferred = value.filter((entry) => preferredDesignArenaEntry(entry))
  const source = preferred.length ? preferred : value
  return source
    .map((entry) => (isRecord(entry) ? numberValue(entry.win_rate) : undefined))
    .filter((score): score is number => score !== undefined)
}

function preferredDesignArenaEntry(value: unknown) {
  if (!isRecord(value)) return false
  const category = stringValue(value.category)
  return ['codecategories', 'fullstack', 'uicomponent', 'webapps'].includes(category ?? '')
}

function payloadItems(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.data)) return []
  return value.data
}

function tokenPrice(value: unknown, key: string) {
  if (!isRecord(value)) return null
  const parsed = numberValue(value[key])
  return parsed === undefined ? null : roundTokenPrice(parsed * 1_000_000)
}

function nestedNumber(value: unknown, key: string) {
  return isRecord(value) ? numberValue(value[key]) : undefined
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function releaseDate(value: unknown) {
  if (typeof value === 'number') return new Date(value * 1000).toISOString()
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

function numberValue(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && !value.trim()) return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function average(values: number[]) {
  if (!values.length) return undefined
  return round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function roundTokenPrice(value: number) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
