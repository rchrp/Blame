import * as React from "react"

import type { SubAgentRow } from "./sub-agents-view"

// The helpers that run right now, for whoever shows them beside the
// conversation (the stats panel). Each call's rows publish themselves while
// the call runs and take themselves back when it ends or leaves the screen.

type Listener = () => void

const running = new Map<string, readonly SubAgentRow[]>()
const listeners = new Set<Listener>()
let snapshot: readonly SubAgentRow[] = []

/**
 * Publishes the helpers of `call` that still work (running or waiting), or
 * takes them back with `undefined`.
 */
export function publishHelpers(
  call: string,
  rows: readonly SubAgentRow[] | undefined
) {
  const open = rows?.filter(
    (row) => row.status === "running" || row.status === "waiting"
  )
  if (open?.length) running.set(call, open)
  else if (!running.delete(call)) return
  snapshot = [...running.values()].flat()
  listeners.forEach((listener) => listener())
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const none: readonly SubAgentRow[] = []

/** Every helper of every call that is running now, in call order. */
export function useRunningHelpers() {
  return React.useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => none
  )
}
