import {
  fetchLiveProviderModels,
  getAllProviders,
  getModelsForProvider,
  resolveProviderModelCatalogKeys,
  type ModelInfo,
  type ProviderInfo,
} from '@cline/llms'
import { parentPort, workerData } from 'node:worker_threads'
import { missingProviderModels, withSupplementalModels } from '@blame/model-catalog'
import type { ClineProviderCatalog } from './cline_catalog_client.js'

type ClineCatalogRequest =
  { kind: 'catalog' } | { kind: 'live'; url: string; providerIds: string[] }

async function loadProviderCatalog() {
  const providers = await getAllProviders()
  return Promise.all(
    providers.map(async (provider: ProviderInfo) => ({
      authoritativeModels: provider.metadata?.usageCostDisplay === 'subscription',
      provider,
      models: withSupplementalModels(provider.id, await getModelsForProvider(provider.id)),
    }))
  ) satisfies Promise<ClineProviderCatalog[]>
}

async function loadLiveCatalog(url: string, providerIds: string[]) {
  const catalog = await fetchLiveProviderModels(url)
  const providers: ProviderInfo[] = await getAllProviders()
  const subscriptionProviders = new Set(
    providers
      .filter((provider) => provider.metadata?.usageCostDisplay === 'subscription')
      .map((provider) => provider.id)
  )
  return Object.fromEntries(
    await Promise.all(
      providerIds.map(async (providerId) => {
        const official = await getModelsForProvider(providerId)
        // Subscription limits, prices and availability belong to that provider.
        // An API alias must not overwrite them once a supplemental model has
        // graduated into Cline's bundled catalog.
        if (subscriptionProviders.has(providerId)) {
          return [providerId, withSupplementalModels(providerId, official)]
        }
        // Only direct provider entries retire a temporary model addition.
        const additions = missingProviderModels(providerId, {
          ...official,
          ...catalog[providerId],
        })
        return [providerId, { ...providerLiveModels(providerId, catalog), ...additions }]
      })
    )
  )
}

function providerLiveModels(
  providerId: string,
  catalog: Record<string, Record<string, ModelInfo>>
) {
  return Object.assign(
    {},
    ...resolveProviderModelCatalogKeys(providerId).map((key: string) => catalog[key] ?? {})
  )
}

function executeRequest(request: ClineCatalogRequest) {
  if (request.kind === 'live') return loadLiveCatalog(request.url, request.providerIds)
  return loadProviderCatalog()
}

async function postResult() {
  try {
    const value = await executeRequest(workerData as ClineCatalogRequest)
    parentPort?.postMessage({ ok: true, value })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    parentPort?.postMessage({ ok: false, message })
  }
}

await postResult()
