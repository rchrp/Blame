export type CatalogCost = {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

export type CatalogBenchmark = {
  smartScore: number
  codingIndex?: number
  agenticIndex?: number
  intelligenceIndex?: number
  designArenaScore?: number
}

export type CatalogModel = {
  id: string
  name: string
  status?: string
  description?: string
  contextWindow?: number
  // The usable input budget, below the window (ChatGPT plans cap it lower).
  maxInputTokens?: number
  maxTokens?: number
  capabilities?: string[]
  releaseDate?: string
  canonicalModelId?: string
  matchConfidence?: number
  benchmark?: CatalogBenchmark
  cost: CatalogCost
  variants?: Record<string, unknown>
}

export type CatalogProvider = {
  id: string
  name: string
  description?: string
  baseUrl?: string
  defaultModelId?: string
  capabilities?: string[]
  models: Record<string, CatalogModel>
}

export type CatalogSnapshotPayload = {
  generatedAt: string
  openRouterModels?: OpenRouterModel[]
  providers: CatalogProvider[]
}

export type OpenRouterModel = {
  id: string
  canonicalSlug: string
  name: string
  contextWindow?: number
  maxTokens?: number
  inputPrice: number | null
  outputPrice: number | null
  cacheReadPrice: number | null
  cacheWritePrice: number | null
  releaseDate?: string
  benchmark?: CatalogBenchmark
}

export type ModelRecommendation = {
  providerId: string
  modelId: string
  position: number
  segment: 'benchmarked' | 'unbenchmarked'
  estimatedCost: number | null
  smartScore?: number
}

export type ModelRecommendationProfile = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  sampleCount: number
}

export type ModelRecommendations = {
  generatedAt: string
  benchmarkBoundary: number
  all: ModelRecommendation[]
  byProvider: Record<string, ModelRecommendation[]>
  profile: ModelRecommendationProfile
}
