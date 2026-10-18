import * as React from "react"

// First-run flow state that outlives a single screen.
//
// The Premium offer appears once, right after someone finishes configuring
// their models for the first time. It is kept in memory only: people who quit
// on the offer go straight to their projects next time.

let premiumOfferPending = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function queuePremiumOffer() {
  premiumOfferPending = true
  emit()
}

export function dismissPremiumOffer() {
  if (!premiumOfferPending) return
  premiumOfferPending = false
  emit()
}

export function usePremiumOfferPending() {
  return React.useSyncExternalStore(
    subscribe,
    () => premiumOfferPending,
    () => false
  )
}

// Keeps the loading screen up for a short beat on start-up, so the brand
// moment reads as intentional instead of flashing for a frame.
export function useMinimumDuration(active: boolean, minimumMs: number) {
  const [startedAt] = React.useState(() => performance.now())
  const [elapsed, setElapsed] = React.useState(false)

  React.useEffect(() => {
    const remaining = minimumMs - (performance.now() - startedAt)
    if (remaining <= 0) {
      const frame = requestAnimationFrame(() => setElapsed(true))
      return () => cancelAnimationFrame(frame)
    }
    const timer = window.setTimeout(() => setElapsed(true), remaining)
    return () => window.clearTimeout(timer)
  }, [minimumMs, startedAt])

  return active || !elapsed
}
