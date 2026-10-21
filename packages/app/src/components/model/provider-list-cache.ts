// The provider list is the same for every model picker: one shared copy,
// shown right away (from the last session too), refreshed in the background
// and fetched once even when several pickers ask at the same time.

type Storage = Pick<globalThis.Storage, "getItem" | "removeItem" | "setItem">

type Entry<T> = { fetchedAt: number; key: string; value: T }

const storageKey = "blame.app.provider-list.v1"
// A picker opened again within this delay reuses the list as is.
const freshForMs = 30_000
// The stored copy stays well under the storage quota.
const maxStoredLength = 2_500_000

export function createProviderListCache<T>(
  options: {
    now?: () => number
    storage?: () => Storage | undefined
  } = {}
) {
  const now = options.now ?? Date.now
  const storage = options.storage ?? defaultStorage
  const listeners = new Set<() => void>()
  let entry: Entry<T> | undefined
  let storedEntryRead = false
  let request: { key: string; promise: Promise<T> } | undefined

  function current(key: string) {
    if (!storedEntryRead) {
      storedEntryRead = true
      entry ??= readStored<T>(storage())
    }
    return entry?.key === key ? entry : undefined
  }

  return {
    read(key: string | undefined) {
      return key ? current(key)?.value : undefined
    },

    load(key: string, fetch: () => Promise<T>, { force = false } = {}) {
      const cached = current(key)
      if (!force && cached && now() - cached.fetchedAt < freshForMs) {
        return Promise.resolve(cached.value)
      }
      if (request?.key === key) return request.promise
      const promise = fetch()
        .then((value) => {
          entry = { fetchedAt: now(), key, value }
          writeStored(storage(), entry)
          listeners.forEach((listener) => listener())
          return value
        })
        .finally(() => {
          if (request?.promise === promise) request = undefined
        })
      request = { key, promise }
      return promise
    },

    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function defaultStorage() {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function readStored<T>(storage: Storage | undefined): Entry<T> | undefined {
  try {
    const value: unknown = JSON.parse(storage?.getItem(storageKey) ?? "null")
    if (!value || typeof value !== "object") return undefined
    const stored = value as Partial<Entry<T>>
    if (typeof stored.key !== "string" || stored.value === undefined)
      return undefined
    // Shown at once, but always refreshed: it comes from a past session.
    return { fetchedAt: 0, key: stored.key, value: stored.value }
  } catch {
    return undefined
  }
}

function writeStored<T>(storage: Storage | undefined, entry: Entry<T>) {
  try {
    const value = JSON.stringify({ key: entry.key, value: entry.value })
    if (value.length > maxStoredLength) storage?.removeItem(storageKey)
    else storage?.setItem(storageKey, value)
  } catch {
    // Best effort: the list is fetched again next time.
  }
}
