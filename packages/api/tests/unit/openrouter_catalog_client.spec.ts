import { fetchOpenRouterCatalog } from '#services/openrouter_catalog_client'
import { test } from '@japa/runner'

test.group('OpenRouter catalog client', () => {
  test('normalizes token prices and benchmark scores', async ({ assert }) => {
    const requests: string[] = []
    const fetcher = async (input: string | URL | Request) => {
      const url = input.toString()
      requests.push(url)
      return url.endsWith('/benchmarks')
        ? jsonResponse(benchmarkPayload)
        : jsonResponse(modelsPayload)
    }

    const models = await fetchOpenRouterCatalog('server-secret', fetcher as typeof fetch)

    assert.lengthOf(models, 1)
    assert.equal(models[0].inputPrice, 2)
    assert.equal(models[0].outputPrice, 8)
    assert.equal(models[0].cacheReadPrice, 0.2)
    assert.equal(models[0].releaseDate, '2026-07-29T12:00:00.000Z')
    assert.equal(models[0].benchmark?.smartScore, 75)
    assert.equal(models[0].benchmark?.codingIndex, 82)
    assert.equal(models[0].benchmark?.agenticIndex, 62)
    assert.isTrue(requests.every((url) => url.startsWith('https://openrouter.ai/api/v1/')))
  })
})

const modelsPayload = {
  data: [
    {
      id: 'openai/gpt-test',
      canonical_slug: 'openai/gpt-test',
      name: 'GPT Test',
      created: '2026-07-29T12:00:00.000Z',
      context_length: 200_000,
      pricing: {
        prompt: '0.000002',
        completion: '0.000008',
        input_cache_read: '0.0000002',
      },
      top_provider: {
        max_completion_tokens: 32_000,
      },
    },
  ],
}

const benchmarkPayload = {
  data: [
    {
      model_permaslug: 'openai/gpt-test',
      coding_index: 82,
      agentic_index: 62,
      intelligence_index: 75,
    },
  ],
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })
}
