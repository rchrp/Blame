import type { CloudProjectInitialization } from "@/context/cloud-auth"

// Whether stories can use the project's preview setup. Only a finished
// initialization gives one. A run counts as in progress while this app
// runs it, or for a while after another app last reported on it: a run
// that stopped reporting (Blame quit, a crash) must not hold stories back.

export type ProjectInitializationAvailability =
  "ready" | "running" | "unavailable"

export const staleInitializationMs = 15 * 60_000

export function projectInitializationAvailability(
  initialization: CloudProjectInitialization | null | undefined,
  options: { runningHere: boolean; now?: number }
): ProjectInitializationAvailability {
  if (initialization?.status === "done" && initialization.previewManifest)
    return "ready"
  if (options.runningHere) return "running"
  if (
    initialization?.status === "running" &&
    !initializationStale(initialization, options.now ?? Date.now())
  )
    return "running"
  return "unavailable"
}

export function initializationStale(
  initialization: Pick<CloudProjectInitialization, "createdAt" | "updatedAt">,
  now = Date.now()
) {
  const reportedAt = Date.parse(
    initialization.updatedAt ?? initialization.createdAt
  )
  return (
    !Number.isFinite(reportedAt) || now - reportedAt > staleInitializationMs
  )
}

/**
 * What a queued story does with the project's initialization. Direct
 * stories need none: they run the project's own app in its folder. The
 * others wait while it runs, and without one (it failed, never ran, or
 * stopped reporting) they run Direct instead of waiting forever.
 */
export function storyInitializationDecision(
  availability: ProjectInitializationAvailability,
  mode: string
): "start" | "wait" | "run-direct" {
  if (availability === "ready" || mode === "direct") return "start"
  return availability === "running" ? "wait" : "run-direct"
}

const runningProjects = new Set<string>()
const runningListeners = new Set<() => void>()

/** Marks a run of this app, so the queue and the page know it is live. */
export function markInitializationRunning(projectId: string, running: boolean) {
  if (running === runningProjects.has(projectId)) return
  if (running) runningProjects.add(projectId)
  else runningProjects.delete(projectId)
  runningListeners.forEach((listener) => listener())
}

export function initializationRunningHere(projectId: string) {
  return runningProjects.has(projectId)
}

export function subscribeInitializationRunning(listener: () => void) {
  runningListeners.add(listener)
  return () => {
    runningListeners.delete(listener)
  }
}
