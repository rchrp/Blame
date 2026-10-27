import * as React from "react"
import type { AgentEvent, InitializationProgress } from "@blame/agent-runtime"

// Live progress of the initialization this app runs, by project: the toast
// and the Initialization page show the same steps. The agent reports them
// as notices on the run's own channel (see agent-runtime's
// initialization-progress.ts).

export type ProjectInitializationProgress = {
  percent: number
  label: string
  detail?: string
  startedAt: number
}

const progressByProject = new Map<string, ProjectInitializationProgress>()
const listeners = new Set<() => void>()

export function initializationProgressChannel(progressId: string) {
  return `initialization:${progressId}`
}

export function agentInitializationProgress(event: AgentEvent) {
  const payload = event.payload as Partial<InitializationProgress> | undefined
  if (payload?.kind !== "initialization_progress") return undefined
  if (typeof payload.percent !== "number" || !payload.label) return undefined
  return {
    percent: payload.percent,
    label: payload.label,
    ...(payload.detail ? { detail: payload.detail } : {}),
  }
}

export function setInitializationProgress(
  projectId: string,
  progress: Omit<ProjectInitializationProgress, "startedAt"> | undefined
) {
  const current = progressByProject.get(projectId)
  if (!progress) progressByProject.delete(projectId)
  else
    progressByProject.set(projectId, {
      ...progress,
      // The bar never moves back, even when a later step reports less.
      percent: Math.max(progress.percent, current?.percent ?? 0),
      startedAt: current?.startedAt ?? Date.now(),
    })
  listeners.forEach((listener) => listener())
}

export function initializationProgressFor(projectId: string) {
  return progressByProject.get(projectId)
}

export function useInitializationProgress(projectId: string | undefined) {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => (projectId ? progressByProject.get(projectId) : undefined)
  )
}
