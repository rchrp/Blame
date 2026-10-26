import type { ProviderListResponse } from "@blame/agent-runtime"

export type ProviderCatalogSnapshot = {
  providers?: ProviderListResponse
  loading: boolean
  failed: boolean
}

export const emptyProviderCatalog: ProviderCatalogSnapshot = {
  loading: false,
  failed: false,
}

const freshnessMs = 5 * 60_000

// One resource per authenticated connection. Never persist credentials or reuse
// another connection's catalog. Mounted selectors share its data and requests.
export function createProviderCatalogResource(
  load: () => Promise<ProviderListResponse>,
  now = Date.now
) {
  let snapshot = emptyProviderCatalog
  let loadedAt: number | undefined
  let pending: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const publish = (next: ProviderCatalogSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const refresh = () => {
    if (pending) return pending
    // Schedule loading after pending is assigned, including synchronous loaders.
    pending = Promise.resolve()
      .then(load)
      .then((providers) => {
        loadedAt = now()
        publish({ providers, loading: false, failed: false })
      })
      .catch((error) => {
        console.error("[renderer] providers:list failed", error)
        publish({ ...snapshot, loading: false, failed: true })
      })
      .finally(() => {
        pending = undefined
      })
    publish({ ...snapshot, loading: true, failed: false })
    return pending
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh,
    refreshIfStale: () =>
      loadedAt === undefined || now() - loadedAt >= freshnessMs
        ? refresh()
        : Promise.resolve(),
  }
}
