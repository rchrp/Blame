import * as React from "react"
import type {
  EngineLocation,
  EnginePlatformClient,
} from "@blame/agent-runtime/engine-protocol"
import { samePlanProgress } from "@blame/engine-client/transcript"
import type { PlanProgress } from "@blame/engine-client/transcript"

import { usePlatform } from "@/context/platform"

// How far each session's plan is, for the cards that show no list. The host
// says it when a plan moves (`onPlan`); a card that appears later asks once
// (`status`), and nothing else reaches the renderer: no transcript is read
// for a card.

type Store = {
  get(session: string): PlanProgress | undefined
  subscribe(
    session: string,
    location: EngineLocation,
    listener: () => void
  ): () => void
}

const stores = new WeakMap<EnginePlatformClient, Store>()

function storeOf(engine: EnginePlatformClient): Store {
  const existing = stores.get(engine)
  if (existing) return existing
  const progress = new Map<string, PlanProgress | undefined>()
  const listeners = new Map<string, Set<() => void>>()
  let stopListening: (() => void) | undefined

  const set = (session: string, next: PlanProgress | undefined) => {
    if (progress.has(session) && samePlanProgress(progress.get(session), next))
      return
    progress.set(session, next)
    for (const listener of listeners.get(session) ?? []) listener()
  }
  const store: Store = {
    get: (session) => progress.get(session),
    subscribe(session, location, listener) {
      const mine = listeners.get(session) ?? new Set()
      listeners.set(session, mine)
      mine.add(listener)
      stopListening ??= engine.onPlan((event) => set(event.session, event.plan))
      // What the host said before this card existed: asked for once, and
      // only when no event has said it since.
      if (!progress.has(session))
        void engine
          .call("status", { sessions: [session], location })
          .then(([status]) => {
            if (!progress.has(session)) set(session, status?.plan)
          })
          .catch(() => undefined)
      return () => {
        mine.delete(listener)
        if (mine.size === 0) listeners.delete(session)
        if (listeners.size === 0) {
          stopListening?.()
          stopListening = undefined
        }
      }
    },
  }
  stores.set(engine, store)
  return store
}

/** How far the plan of `session` is, live; nothing without one. */
export function usePlanProgress(
  session: string | null | undefined,
  location: EngineLocation = "host"
): PlanProgress | undefined {
  const engine = usePlatform().engine
  const store = engine ? storeOf(engine) : undefined
  const subscribe = React.useCallback(
    (listener: () => void) =>
      store && session
        ? store.subscribe(session, location, listener)
        : () => undefined,
    [location, session, store]
  )
  return React.useSyncExternalStore(subscribe, () =>
    store && session ? store.get(session) : undefined
  )
}
