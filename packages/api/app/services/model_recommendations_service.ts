import type {
  CatalogModel,
  CatalogProvider,
  OpenRouterModel,
} from '#services/model_catalog_contract'
import { ModelCatalogMatcher } from '#services/model_catalog_matcher'
import { buildModelRecommendations } from '#services/model_recommendation_service'
import ModelUsageProfileService from '#services/model_usage_profile_service'
import { fetchOpenRouterCatalog } from '#services/openrouter_catalog_client'
import env from '#start/env'
import logger from '@adonisjs/core/services/logger'

/** One model a client offers, as the engine's models.dev catalog lists it. */
export type OfferedModel = {
  providerId: string
  modelId: string
  name: string
  releaseDate?: string
  /** USD per million tokens. */
  cost: { input: number | null; output: number | null; cacheRead?: number | null }
}

// OpenRouter's benchmarks change daily at most; one copy serves everyone.
const benchmarksTtlMs = 6 * 60 * 60_000
// After a failure, ask again soon rather than at every picker opening.
const failedTtlMs = 5 * 60_000
let benchmarks: { expiresAt: number; models: Promise<OpenRouterModel[]> } | undefined

/**
 * Ranks the models a client offers by benchmark and by what the person's
 * own usage would cost. The API keeps no catalog: the engine reads
 * models.dev, and the client sends what it offers.
 */
export default class ModelRecommendationsService {
  async recommend(userId: string, input: { connected: string[]; models: OfferedModel[] }) {
    const [references, profile] = await Promise.all([
      openRouterModels(),
      new ModelUsageProfileService().forUser(userId),
    ])
    const matcher = new ModelCatalogMatcher(references)
    const providers = new Map<string, CatalogProvider>()
    for (const offered of input.models) {
      const provider = providers.get(offered.providerId) ?? {
        id: offered.providerId,
        name: offered.providerId,
        models: {},
      }
      provider.models[offered.modelId] = enrich(offered.providerId, catalogModel(offered), matcher)
      providers.set(offered.providerId, provider)
    }
    return buildModelRecommendations(
      [...providers.values()],
      input.connected,
      profile,
      new Date().toISOString()
    )
  }
}

function catalogModel(offered: OfferedModel): CatalogModel {
  return {
    id: offered.modelId,
    name: offered.name,
    ...(offered.releaseDate ? { releaseDate: offered.releaseDate } : {}),
    cost: {
      input: offered.cost.input,
      output: offered.cost.output,
      cacheRead: offered.cost.cacheRead ?? null,
      cacheWrite: null,
    },
  }
}

/** The benchmark OpenRouter has for the model, and its price when none is given. */
function enrich(providerId: string, model: CatalogModel, matcher: ModelCatalogMatcher) {
  const match = matcher.match(providerId, model)
  if (!match) return model
  return {
    ...model,
    releaseDate: model.releaseDate ?? match.model.releaseDate,
    canonicalModelId: match.model.canonicalSlug,
    matchConfidence: match.confidence,
    benchmark: match.model.benchmark,
    cost: {
      input: model.cost.input ?? match.model.inputPrice,
      output: model.cost.output ?? match.model.outputPrice,
      cacheRead: model.cost.cacheRead ?? match.model.cacheReadPrice,
      cacheWrite: model.cost.cacheWrite,
    },
  }
}

function openRouterModels() {
  if (benchmarks && benchmarks.expiresAt > Date.now()) return benchmarks.models
  if (env.get('BLAME_MODEL_BENCHMARKS') === false) return Promise.resolve([])
  const apiKey = env.get('OPENROUTER_API_KEY')?.release().trim() || undefined
  const entry = {
    expiresAt: Date.now() + benchmarksTtlMs,
    models: fetchOpenRouterCatalog(apiKey).catch((error) => {
      logger.warn({ err: error }, 'Unable to load OpenRouter model benchmarks')
      entry.expiresAt = Date.now() + failedTtlMs
      return [] as OpenRouterModel[]
    }),
  }
  benchmarks = entry
  return entry.models
}
