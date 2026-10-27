import {
  loadClineProviderCatalog,
  fetchClineLiveProviderModels,
} from '#services/cline_catalog_client'
import { test } from '@japa/runner'
import { getModelsForProvider } from '@cline/llms'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

test.group('Cline provider catalog worker', () => {
  test('uses official Astra metadata for each provider after retiring its supplement', async ({
    assert,
  }) => {
    const catalog = await loadClineProviderCatalog()
    const codex = catalog.find(({ provider }) => provider.id === 'openai-codex')
    assert.isTrue(codex?.authoritativeModels)
    assert.equal(codex?.models['gpt-6-astra']?.name, 'GPT-6 Astra')
    const officialCodex = await getModelsForProvider('openai-codex')
    const officialApi = await getModelsForProvider('openai-native')
    assert.deepEqual(codex?.models['gpt-6-astra'], officialCodex['gpt-6-astra'])
    assert.deepEqual(
      catalog.find(({ provider }) => provider.id === 'openai-native')?.models['gpt-6-astra'],
      officialApi['gpt-6-astra']
    )
  })

  test('a live API alias cannot replace subscription metadata or expand its allowlist', async ({
    assert,
  }) => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          openai: {
            id: 'openai',
            name: 'OpenAI',
            models: {
              'gpt-6-astra': {
                id: 'gpt-6-astra',
                name: 'Live Astra',
                tool_call: true,
                limit: { context: 1_050_000, output: 128_000 },
                cost: { input: 1234, output: 5678 },
              },
              'api-only-model': {
                id: 'api-only-model',
                name: 'API only',
                tool_call: true,
                limit: { context: 1_000_000, output: 128_000 },
              },
            },
          },
        })
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api.json`
      const live = await fetchClineLiveProviderModels(url, ['openai-native', 'openai-codex'])
      assert.equal(live['openai-native']['gpt-6-astra'].name, 'Live Astra')
      assert.equal(live['openai-native']['gpt-6-astra'].contextWindow, 1_050_000)
      assert.equal(live['openai-native']['gpt-6-astra'].pricing?.input, 1234)
      assert.exists(live['openai-native']['api-only-model'])
      assert.deepEqual(live['openai-codex'], await getModelsForProvider('openai-codex'))
      assert.isUndefined(live['openai-codex']['api-only-model'])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
