import * as React from "react"

import { hasImportable } from "@/components/agent-import/agent-import-model"
import type { AgentImportClient, AgentImportScan } from "@/context/platform"

// The first-run "Bring your setup" step: offered once per computer, after the
// provider is connected, and only when the other tools hold something Blame
// can import. Skipping or finishing ends it for good; Settings runs the same
// review whenever the person wants.
const doneKey = "blame.agent-import-done.v1"

type Offer = "idle" | "checking" | "offer" | "none"

let done = readDone()
let offer: Offer = "idle"
// The step stays in the journey's progress once it was shown.
let shown = false
let scanned: AgentImportScan | undefined
const listeners = new Set<() => void>()

function readDone() {
  try {
    return window.localStorage.getItem(doneKey) === "true"
  } catch {
    return false
  }
}

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function set(next: Offer) {
  if (offer === next) return
  offer = next
  if (next === "offer") shown = true
  emit()
}

async function check(client: AgentImportClient) {
  set("checking")
  try {
    scanned = await client.scan()
    set(hasImportable(scanned) ? "offer" : "none")
  } catch {
    // Nothing to offer is better than a first run stuck on a failed scan.
    set("none")
  }
}

export function finishAgentImportOffer() {
  if (done) return
  done = true
  try {
    window.localStorage.setItem(doneKey, "true")
  } catch {
    // Offered again next time; harmless.
  }
  emit()
}

/** The scan the offer was decided on, so the step does not read twice. */
export function offeredScan() {
  return scanned
}

export function useAgentImportOffer(
  client: AgentImportClient | undefined,
  enabled: boolean
): "checking" | "offer" | "none" {
  const state = React.useSyncExternalStore(
    subscribe,
    () => (done ? "none" : offer),
    () => "none"
  )
  React.useEffect(() => {
    if (enabled && client && !done && offer === "idle") void check(client)
  }, [client, enabled])
  if (done || !client) return "none"
  if (state === "checking" || (state === "idle" && enabled)) return "checking"
  return state === "offer" ? "offer" : "none"
}

/** Whether the journey's progress lists the step. */
export function useAgentImportStepShown() {
  return React.useSyncExternalStore(
    subscribe,
    () => shown,
    () => false
  )
}
