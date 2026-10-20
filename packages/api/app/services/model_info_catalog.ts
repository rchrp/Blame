import ModelCatalogSnapshot from '#models/model_catalog_snapshot'
import type { ModelInfo } from '@cline/llms'
import type { DateTime } from 'luxon'

/**
 * Complete Cline model metadata, kept apart from the catalog snapshot so that
 * listing models never parses it. Desktop runtimes fetch one entry when their
 * bundled SDK does not know a model yet.
 */
export type ModelInfoCatalog = Record<string, Record<string, ModelInfo>>

const snapshotId = 'global:model-info'
let cached: { refreshedAt: number; catalog: ModelInfoCatalog } | undefined

export function mergeModelInfo(...catalogs: ModelInfoCatalog[]) {
  const merged: ModelInfoCatalog = {}
  for (const catalog of catalogs) {
    for (const [providerId, models] of Object.entries(catalog)) {
      merged[providerId] = { ...merged[providerId], ...models }
    }
  }
  return merged
}

export async function saveModelInfo(
  catalog: ModelInfoCatalog,
  catalogHash: string,
  refreshedAt: DateTime
) {
  await ModelCatalogSnapshot.updateOrCreate(
    { id: snapshotId },
    { catalogHash, payload: JSON.stringify(catalog), refreshedAt }
  )
  cached = { refreshedAt: refreshedAt.toMillis(), catalog }
}

export async function findModelInfo(providerId: string, modelId: string) {
  const snapshot = await ModelCatalogSnapshot.find(snapshotId)
  if (!snapshot) return undefined
  const refreshedAt = snapshot.refreshedAt.toMillis()
  if (cached?.refreshedAt !== refreshedAt) {
    cached = { refreshedAt, catalog: JSON.parse(snapshot.payload) as ModelInfoCatalog }
  }
  const model = cached.catalog[providerId]?.[modelId]
  return model ? structuredClone(model) : undefined
}
