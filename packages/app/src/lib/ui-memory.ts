import * as React from "react"

// Small, forgiving storage for interface preferences: panel sizes, collapsed
// sections, the last tab of a story, a scroll position. Storage can be full,
// blocked or cleared; every read falls back and every write is best effort.

const prefix = "blame.ui."

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">

function defaultStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function readUiMemory<T>(
  key: string,
  isValue: (value: unknown) => value is T,
  storage: Storage | undefined = defaultStorage()
): T | undefined {
  try {
    const raw = storage?.getItem(prefix + key)
    if (raw == null) return undefined
    const value: unknown = JSON.parse(raw)
    return isValue(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function writeUiMemory(
  key: string,
  value: unknown,
  storage: Storage | undefined = defaultStorage()
) {
  try {
    storage?.setItem(prefix + key, JSON.stringify(value))
  } catch {
    // Best effort.
  }
}

// One value per item (story, chat…), keeping only the most recent ones so
// the stored map never grows without bound.
export function rememberForItem<T>(
  key: string,
  itemId: string,
  value: T,
  { limit = 200, storage = defaultStorage() }: { limit?: number; storage?: Storage } = {}
) {
  const current = readUiMemory(key, isRecord, storage) ?? {}
  delete current[itemId]
  const entries = [...Object.entries(current), [itemId, value] as const]
  writeUiMemory(key, Object.fromEntries(entries.slice(-limit)), storage)
}

export function recallForItem<T>(
  key: string,
  itemId: string,
  isValue: (value: unknown) => value is T,
  storage: Storage | undefined = defaultStorage()
): T | undefined {
  const value = readUiMemory(key, isRecord, storage)?.[itemId]
  return isValue(value) ? value : undefined
}

export function useUiMemory<T>(
  key: string,
  fallback: T,
  isValue: (value: unknown) => value is T
) {
  const [value, setValue] = React.useState<T>(
    () => readUiMemory(key, isValue) ?? fallback
  )
  const update = React.useCallback(
    (next: T | ((current: T) => T)) => {
      setValue((current) => {
        const resolved =
          typeof next === "function" ? (next as (current: T) => T)(current) : next
        writeUiMemory(key, resolved)
        return resolved
      })
    },
    [key]
  )
  return [value, update] as const
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
