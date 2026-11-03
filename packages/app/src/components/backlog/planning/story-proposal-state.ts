import * as React from "react"

import type { PlanStoryDecision } from "./story-proposal-data"

// The person's decisions on proposed stories (edits, dismissals, stories
// added), per project and proposal. Kept on this computer: the proposal
// itself lives in the conversation.

type ProposalDecisions = Record<string, Record<string, PlanStoryDecision>>

const storageVersion = 1
const maxProposals = 300
const listeners = new Set<() => void>()
const cache = new Map<string, ProposalDecisions>()
const empty: ProposalDecisions = {}

function storageKey(projectId: string) {
  return `blame:story-proposals:v${storageVersion}:${projectId}`
}

export function proposalDecisions(projectId: string | undefined) {
  if (!projectId) return empty
  const cached = cache.get(projectId)
  if (cached) return cached
  let value = empty
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    const parsed = raw ? (JSON.parse(raw) as unknown) : undefined
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      value = parsed as ProposalDecisions
  } catch {
    // Unreadable decisions start over; the proposals stay in the thread.
  }
  cache.set(projectId, value)
  return value
}

export function decideProposalStory(
  projectId: string | undefined,
  proposalId: string,
  key: string,
  patch: PlanStoryDecision
) {
  if (!projectId) return
  const current = proposalDecisions(projectId)
  const entries = Object.entries({
    ...current,
    [proposalId]: {
      ...current[proposalId],
      [key]: { ...current[proposalId]?.[key], ...patch },
    },
  })
  // The most recent proposals win when the store is full.
  const next = Object.fromEntries(entries.slice(-maxProposals))
  cache.set(projectId, next)
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(next))
  } catch {
    // The decision still applies until the app restarts.
  }
  for (const listener of listeners) listener()
}

export function useProposalDecisions(projectId: string | undefined) {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => proposalDecisions(projectId)
  )
}
