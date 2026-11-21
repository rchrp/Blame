import type { EngineModelChoice } from "@blame/agent-runtime/engine-protocol"

// An epic of the project: a goal the orchestrator pursues through user
// stories, an integration branch they merge into and a budget
// (docs/orchestrator.md, "The epic"). A row of the API's `epics`.

export type EpicStatus = "active" | "paused" | "completed" | "discarded"

export type EpicModelKey = { providerId: string; modelId: string }

// The model the orchestrator runs on, as the engine takes it.
export type EpicOrchestratorModel = EngineModelChoice

// The keys the host reads on every turn of the orchestrator. The object may
// hold others: a PATCH replaces it whole, so they are sent back as read.
export type EpicSettings = {
  orchestratorModel?: EpicOrchestratorModel
  // The slice of the smart ranking stories may use, 0 (cheapest) to 1.
  modelRange?: { min: number; max: number }
  // Empty or absent: every connected provider.
  providers?: string[]
  hiddenModels?: EpicModelKey[]
  budgetMicroUsd?: number
  askBeforeLaunch?: boolean
  [key: string]: unknown
}

export type Epic = {
  id: string
  projectId: string
  title: string
  goal: string | null
  status: EpicStatus
  branch: string | null
  targetBranch: string | null
  engineSessionId: string | null
  settings: EpicSettings
  mergedAt: string | null
  mergeCommit: string | null
  createdAt: string
  updatedAt: string | null
}

export type EpicDraft = {
  projectId: string
  title: string
  goal?: string | null
  targetBranch?: string | null
  settings?: EpicSettings
}

export type EpicUpdate = Partial<
  Pick<Epic, "title" | "goal" | "status" | "settings">
>

export const wholeModelRange = { min: 0, max: 1 } as const

export function epicModelRange(settings: EpicSettings) {
  const range = settings.modelRange
  if (!range) return { ...wholeModelRange }
  return {
    min: Math.max(0, Math.min(range.min, range.max)),
    max: Math.min(1, Math.max(range.min, range.max)),
  }
}

const titleLength = 80

/** A title from the goal's first line, for an epic the person did not name. */
export function epicTitleFromGoal(goal: string) {
  const line =
    goal
      .split("\n")
      .map((item) => item.replace(/^[#>*\-\s]+/, "").trim())
      .find(Boolean) ?? ""
  if (line.length <= titleLength) return line
  const cut = line.slice(0, titleLength)
  const space = cut.lastIndexOf(" ")
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`
}

const microUsdPerUsd = 1_000_000

export function budgetMicroUsd(dollars: string) {
  const value = Number(dollars.replace(/[$,\s]/g, ""))
  if (!dollars.trim() || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value * microUsdPerUsd)
}

export function budgetDollars(microUsd: number | undefined) {
  if (microUsd === undefined) return ""
  return String(Math.round(microUsd / 10_000) / 100)
}

export function formatMicroUsd(microUsd: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(microUsd / microUsdPerUsd)
}
