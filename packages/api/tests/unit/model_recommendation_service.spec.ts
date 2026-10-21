import type {
  CatalogModel,
  CatalogProvider,
  ModelRecommendationProfile,
} from '#services/model_catalog_contract'
import { buildModelRecommendations } from '#services/model_recommendation_service'
import { test } from '@japa/runner'

const profile: ModelRecommendationProfile = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  sampleCount: 1,
}

test.group('model recommendation service', () => {
  test('keeps the benchmarked price and intelligence Pareto frontier', ({ assert }) => {
    const provider = catalogProvider('openai', [
      model('cheap', 1, 40),
      model('balanced', 3, 70),
      model('dominated', 4, 60),
      model('smart', 8, 90),
    ])

    const recommendations = buildModelRecommendations(
      [provider],
      [provider.id],
      profile,
      '2026-07-30T00:00:00.000Z'
    )

    assert.deepEqual(
      recommendations.all.map((entry) => entry.modelId),
      ['cheap', 'balanced', 'smart']
    )
    assert.isTrue(recommendations.all.every((entry) => entry.position <= 0.74))
  })

  test('puts recent unbenchmarked models in the final segment sorted by price', ({ assert }) => {
    const provider = catalogProvider('anthropic', [
      model('rated', 2, 50),
      model('new-expensive', 9, undefined, '2026-07-30'),
      model('old-unrated', 1, undefined, '2025-06-01'),
      model('unknown-release', 1),
      model('new-cheap-old', 3, undefined, '2026-06-01'),
      model('new-cheap-recent', 3, undefined, '2026-07-29'),
    ])

    const recommendations = buildModelRecommendations(
      [provider],
      [provider.id],
      profile,
      '2026-07-30T00:00:00.000Z'
    )
    const unbenchmarked = recommendations.all.filter((entry) => entry.segment === 'unbenchmarked')

    assert.deepEqual(
      unbenchmarked.map((entry) => entry.modelId),
      ['new-cheap-recent', 'new-cheap-old', 'new-expensive']
    )
    assert.isTrue(unbenchmarked.every((entry) => entry.position >= 0.8))
  })

  test('deduplicates canonical models across providers using estimated task cost', ({ assert }) => {
    const direct = catalogProvider('openai', [model('gpt-direct', 4, 80, undefined, 'openai/gpt')])
    const routed = catalogProvider('openrouter', [
      model('openai/gpt', 3, 80, undefined, 'openai/gpt'),
    ])

    const recommendations = buildModelRecommendations(
      [direct, routed],
      [direct.id, routed.id],
      profile,
      '2026-07-30T00:00:00.000Z'
    )

    assert.lengthOf(recommendations.all, 1)
    assert.equal(recommendations.all[0].providerId, 'openrouter')
    assert.lengthOf(recommendations.byProvider.openai, 1)
    assert.lengthOf(recommendations.byProvider.openrouter, 1)
  })

  test('ranks only on comparable scores and keeps new models known by another measure', ({
    assert,
  }) => {
    // Brand-new models often come with an intelligence index or a design
    // arena win rate only: on another scale, they must not look weaker.
    const provider = catalogProvider('openai-codex', [
      model('gpt-5.6-luna', 0.2, 50, '2026-07-09'),
      model('gpt-5.6-terra', 2, 62, '2026-07-09'),
      model('gpt-5.6-sol', 4, 70, '2026-07-09'),
      partiallyRated('gpt-6-luna', 0.1, { intelligenceIndex: 30 }, '2026-09-22'),
      partiallyRated('gpt-6-sol', 2, { designArenaScore: 0.6 }, '2026-09-22'),
      partiallyRated('gpt-6-astra', 10, { codingIndex: 88 }, '2026-09-04'),
    ])

    const recommendations = buildModelRecommendations(
      [provider],
      [provider.id],
      profile,
      '2026-10-21T00:00:00.000Z'
    )
    const segment = (name: string) =>
      recommendations.all.filter((entry) => entry.segment === name).map((entry) => entry.modelId)

    assert.deepEqual(segment('benchmarked'), ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'])
    assert.deepEqual(segment('unbenchmarked'), ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'])
  })
})

function partiallyRated(
  id: string,
  inputPrice: number,
  benchmark: Omit<NonNullable<CatalogModel['benchmark']>, 'smartScore'>,
  releaseDate: string
): CatalogModel {
  const fallbackScore =
    benchmark.codingIndex ?? benchmark.intelligenceIndex ?? benchmark.designArenaScore ?? 0
  return {
    ...model(id, inputPrice, undefined, releaseDate),
    benchmark: { ...benchmark, smartScore: fallbackScore },
  }
}

function catalogProvider(id: string, models: CatalogModel[]): CatalogProvider {
  return {
    id,
    name: id,
    models: Object.fromEntries(models.map((entry) => [entry.id, entry])),
  }
}

function model(
  id: string,
  inputPrice: number,
  smartScore?: number,
  releaseDate?: string,
  canonicalModelId?: string
): CatalogModel {
  return {
    id,
    name: id,
    releaseDate,
    canonicalModelId,
    benchmark:
      smartScore === undefined
        ? undefined
        : { smartScore, codingIndex: smartScore, agenticIndex: smartScore },
    cost: {
      input: inputPrice,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    },
  }
}
