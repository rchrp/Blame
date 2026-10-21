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

  test('does not let legacy coding scores dominate newer intelligence scores', ({ assert }) => {
    // Values observed in the API on 2026-10-21, with a fixed synthetic token mix.
    const entries = [
      ['gpt-6-luna', 0.1, 38.1, 38.1],
      ['gpt-5.6-luna', 0.2, 62.61, 37.3],
      ['gpt-5.6-terra', 2, 66.65, 42.1],
      ['gpt-5.6-sol', 4, 69.24, 47],
      ['gpt-6.1-sol', 2, 51.8, 51.8],
      ['gpt-6-astra', 10, 69.13, 52.7],
    ] as const
    const provider = catalogProvider(
      'openai-codex',
      entries.map(([id, price, legacy, intelligence]) => ({
        ...model(id, price),
        benchmark: { smartScore: legacy, intelligenceIndex: intelligence },
      }))
    )

    const result = buildModelRecommendations([provider], [provider.id], profile, '2026-10-21')

    assert.equal(result.rankingMetric, 'intelligenceIndex')
    assert.deepEqual(
      result.all.map((entry) => entry.modelId),
      ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']
    )
    assert.deepEqual(
      result.all.map((entry) => entry.smartScore),
      [38.1, 51.8, 52.7]
    )
  })

  test('keeps partial benchmarks outside the comparable frontier', ({ assert }) => {
    const partial = {
      ...model('new-coding', 1, undefined, '2026-10-20'),
      benchmark: { smartScore: 99, codingIndex: 99 },
    }
    const provider = catalogProvider('openai', [model('intelligence', 2, 50), partial])
    const result = buildModelRecommendations([provider], [provider.id], profile, '2026-10-21')

    assert.equal(result.all[0].modelId, 'intelligence')
    assert.equal(result.all[1].segment, 'unbenchmarked')
    assert.isUndefined(result.all[1].smartScore)
  })

  test('prices cache reads once and uses input price when no cache tariff is known', ({
    assert,
  }) => {
    const cached = {
      ...model('cached', 2, 50),
      cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: null },
    }
    const fallback = { ...model('fallback', 2, 60), cost: { ...cached.cost, cacheRead: null } }
    const provider = catalogProvider('openai', [cached, fallback])
    const result = buildModelRecommendations(
      [provider],
      [provider.id],
      {
        inputTokens: 1_000_000,
        cacheReadTokens: 800_000,
        outputTokens: 100_000,
        sampleCount: 1,
      },
      '2026-10-21'
    )

    assert.deepEqual(
      result.all.map((entry) => entry.estimatedCost),
      [1.48, 3]
    )
  })

  test('does not rank an incomplete price as cheaper than a fully priced model', ({ assert }) => {
    const incomplete = { ...model('new-unknown-output', 0.1, 99, '2026-10-20') }
    const complete = {
      ...model('complete', 1, 50),
      cost: { input: 1, output: 2, cacheRead: null, cacheWrite: null },
    }
    const provider = catalogProvider('openai', [incomplete, complete])
    const result = buildModelRecommendations(
      [provider],
      [provider.id],
      {
        ...profile,
        outputTokens: 100_000,
      },
      '2026-10-21'
    )

    assert.equal(result.all[0].modelId, 'complete')
    assert.equal(result.all[1].segment, 'unbenchmarked')
    assert.isNull(result.all[1].estimatedCost)
  })
})

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
    benchmark: smartScore === undefined ? undefined : { smartScore, intelligenceIndex: smartScore },
    cost: {
      input: inputPrice,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    },
  }
}
