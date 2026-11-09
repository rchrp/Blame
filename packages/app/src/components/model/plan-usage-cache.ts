// The plan usage of an account is the same in the story drawer, in Chat and
// in Settings: one shared copy, shown right away, fetched once however many
// components ask at the same time, and refreshed by a single timer while
// any of them is shown.

import type { SubscriptionUsage } from "@blame/agent-runtime"

export type PlanUsageEntry =
  | { failed: true }
  | { failed: false; fetchedAt: number; usage: SubscriptionUsage | null }

type FetchUsage = () => Promise<SubscriptionUsage | null>

// Calls `refresh` now and then; returns what stops it.
type Schedule = (refresh: () => void) => () => void

type Slot = {
  entry?: PlanUsageEntry
  request?: Promise<void>
  watcher?: { count: number; fetch: FetchUsage; stop: () => void }
}

// A usage younger than this is reused as is: about a minute.
const freshForMs = 55_000
// A shade over freshForMs, so every tick finds the usage stale.
const refreshEveryMs = 60_000
const claudeCodeProviderId = "claude-code"

/**
 * One entry per account and provider. Claude Code reports the plan of the
 * signed-in CLI whatever the credential; ChatGPT's follows the credential.
 */
export function planUsageKey(
  account: string,
  providerId: string,
  credentialLabel: string | undefined
) {
  const label =
    providerId === claudeCodeProviderId ? undefined : credentialLabel
  return JSON.stringify([account, providerId, label ?? null])
}

export function createPlanUsageCache(
  options: {
    now?: () => number
    schedule?: Schedule
  } = {}
) {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? scheduleInBrowser
  const slots = new Map<string, Slot>()
  const listeners = new Set<() => void>()

  function slotOf(key: string) {
    let slot = slots.get(key)
    if (!slot) {
      slot = {}
      slots.set(key, slot)
    }
    return slot
  }

  function notify() {
    listeners.forEach((listener) => listener())
  }

  function isFresh(entry: PlanUsageEntry | undefined) {
    return !!entry && !entry.failed && now() - entry.fetchedAt < freshForMs
  }

  // A failure is not kept as a usage: the next ask fetches again.
  function load(key: string, fetch: FetchUsage, { force = false } = {}) {
    const slot = slotOf(key)
    if (!force && isFresh(slot.entry)) return Promise.resolve()
    if (slot.request) return slot.request
    const startedAt = now()
    const request: Promise<void> = Promise.resolve()
      .then(fetch)
      .then(
        (usage): PlanUsageEntry => ({
          failed: false,
          fetchedAt: startedAt,
          usage,
        }),
        (): PlanUsageEntry => ({ failed: true })
      )
      .then((entry) => {
        // Cleared meanwhile: the answer may belong to a past connection.
        if (slot.request !== request) return
        slot.request = undefined
        slot.entry = entry
        notify()
      })
    slot.request = request
    return request
  }

  function clear() {
    for (const [key, slot] of slots) {
      slot.entry = undefined
      slot.request = undefined
      if (!slot.watcher) slots.delete(key)
    }
    notify()
  }

  return {
    clear,

    load,

    read(key: string | undefined) {
      return key ? slots.get(key)?.entry : undefined
    },

    /** Clears, then asks again for what is still shown. */
    reload() {
      clear()
      for (const [key, slot] of slots) {
        if (slot.watcher) void load(key, slot.watcher.fetch)
      }
    },

    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    /**
     * Loads the usage if it is stale and keeps it fresh until every watcher
     * of this key has stopped: one timer per key, whoever watches it.
     */
    watch(key: string, fetch: FetchUsage) {
      const slot = slotOf(key)
      if (slot.watcher) {
        slot.watcher.count += 1
        slot.watcher.fetch = fetch
      } else {
        slot.watcher = {
          count: 1,
          fetch,
          stop: schedule(() => {
            if (slot.watcher) void load(key, slot.watcher.fetch)
          }),
        }
      }
      void load(key, fetch)
      return () => {
        const watcher = slot.watcher
        if (!watcher) return
        watcher.count -= 1
        if (watcher.count > 0) return
        watcher.stop()
        slot.watcher = undefined
      }
    },
  }
}

function scheduleInBrowser(refresh: () => void) {
  const refreshWhenVisible = () => {
    if (document.visibilityState === "visible") refresh()
  }
  const timer = window.setInterval(refreshWhenVisible, refreshEveryMs)
  window.addEventListener("focus", refreshWhenVisible)
  return () => {
    window.clearInterval(timer)
    window.removeEventListener("focus", refreshWhenVisible)
  }
}

export const planUsages = createPlanUsageCache()
