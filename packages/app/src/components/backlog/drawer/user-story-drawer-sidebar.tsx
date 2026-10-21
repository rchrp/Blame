import * as React from "react"
import type { AgentUsageSummary, AgentUsageTotals } from "@blame/agent-runtime"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import type { UserStoryDiffStats } from "@/components/backlog/development/user-story-diff-stats"
import {
  compactTokens,
  storyContextUsage,
  type StoryContextUsage,
} from "@/components/backlog/drawer/story-context-usage"
import {
  getVariantLabel,
  useModelDisplayNames,
  useModelSelection,
} from "@/components/model/model-selection"
import { ProviderIcon } from "@/components/model/model-selector"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { usePlatform } from "@/context/platform"
import { cn } from "@/lib/utils"

// The story's agent at a glance: which model, how full its context is, and
// what the work cost and changed.
export function DrawerSidebar({
  diffStats,
  userStory,
}: {
  diffStats?: UserStoryDiffStats
  userStory?: UserStory
}) {
  const sessionUsage = useSessionUsage(
    userStory?.agentUsage ? undefined : userStory?.clineSessionId
  )
  const selection = useModelSelection()
  const limit = modelContextLimit(userStory, selection.allProviders)
  const totals =
    usageTotalsFromAgentUsage(userStory?.agentUsage) ?? sessionUsage.totals
  const context = storyContextUsage(userStory?.agentUsage, limit)

  return (
    <aside className="grid gap-4 p-4">
      <ModelHeader userStory={userStory} />
      <ContextGauge context={context} limit={limit} />
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Cost">
          {formatCurrency(totals?.totalCost ?? totals?.cost)}
        </Stat>
        <TokensStat totals={totals} />
        <Stat label="Changes">
          {diffStats ? (
            <span className="flex gap-1.5">
              <span className="text-emerald-600 dark:text-emerald-400">
                +{diffStats.additions}
              </span>
              <span className="text-rose-600 dark:text-rose-400">
                −{diffStats.deletions}
              </span>
            </span>
          ) : (
            "—"
          )}
        </Stat>
      </div>
    </aside>
  )
}

function ModelHeader({ userStory }: { userStory?: UserStory }) {
  const names = useModelDisplayNames()
  const providerId = userStory?.agentProviderId
  const modelId = userStory?.agentModelId
  const effort = latestReasoningEffort(userStory)
  if (!providerId || !modelId) return null
  return (
    <div className="flex min-w-0 items-center gap-2 pr-8">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] ring-1 ring-foreground/10">
        <ProviderIcon className="size-4" providerId={providerId} />
      </span>
      <div className="grid min-w-0 leading-tight">
        <span className="truncate text-sm font-medium text-foreground">
          {names.model(providerId, modelId)}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {effort
            ? `${getVariantLabel(effort)} reasoning`
            : names.provider(providerId)}
        </span>
      </div>
    </div>
  )
}

const contextCells = 50

function ContextGauge({
  context,
  limit,
}: {
  context?: StoryContextUsage
  limit?: number
}) {
  const ratio = context?.ratio ?? 0
  const cachedCells = context
    ? Math.round((context.cached / context.limit) * contextCells)
    : 0
  const usedCells = context ? Math.max(1, Math.round(ratio * contextCells)) : 0
  return (
    <section className="grid gap-2.5" aria-label="Context window">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">
          Context
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {context ? (
            <>
              <span className="text-sm font-semibold text-foreground">
                {Math.round(ratio * 100)}%
              </span>{" "}
              · {compactTokens(context.used)} / {compactTokens(context.limit)}
            </>
          ) : limit ? (
            `${compactTokens(limit)} window`
          ) : null}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(25,minmax(0,1fr))] gap-[3px]">
        {Array.from({ length: contextCells }, (_, index) => (
          <span
            key={index}
            className={cn(
              "h-2 rounded-[3px] transition-colors duration-500",
              index < Math.min(cachedCells, usedCells)
                ? "bg-blue-500"
                : index < usedCells
                  ? "bg-violet-400"
                  : "bg-foreground/[0.08]",
              index >= usedCells && ratio >= 0.8 && "bg-amber-500/20"
            )}
          />
        ))}
      </div>
      {context ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
          <Legend
            className="bg-blue-500"
            label="Reused"
            value={context.cached}
          />
          <Legend className="bg-violet-400" label="New" value={context.fresh} />
          <Legend
            className="bg-foreground/15"
            label="Free"
            value={context.free}
          />
        </div>
      ) : null}
      <p className="text-xs text-pretty text-muted-foreground">
        {contextNote(context)}
      </p>
    </section>
  )
}

function contextNote(context?: StoryContextUsage) {
  if (!context) return "Shows how full the agent's memory is once it runs."
  if (context.ratio >= 0.8)
    return "Almost full: the agent will summarize its older steps soon."
  if (context.ratio >= 0.5) return "Filling up, still room to work."
  return "Plenty of room left."
}

function Legend({
  className,
  label,
  value,
}: {
  className: string
  label: string
  value: number
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-2 rounded-[2px]", className)} />
      {label} <span className="text-foreground/80">{compactTokens(value)}</span>
    </span>
  )
}

function Stat({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <div className="grid min-w-0 gap-0.5 rounded-lg bg-foreground/[0.04] px-2.5 py-2 ring-1 ring-foreground/[0.06]">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="truncate text-sm font-medium text-foreground tabular-nums">
        {children}
      </span>
    </div>
  )
}

function TokensStat({ totals }: { totals?: AgentUsageTotals }) {
  if (!totals) return <Stat label="Tokens">—</Stat>
  const input = totals.totalInputTokens
  const output = totals.totalOutputTokens
  const cached = totals.totalCacheReadTokens ?? 0
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          className="min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Stat label="Tokens">{compactTokens(input + output)}</Stat>
        </div>
      </TooltipTrigger>
      <TooltipContent className="tabular-nums">
        In {compactTokens(input)} · Out {compactTokens(output)}
        {cached ? ` · Read from cache ${compactTokens(cached)}` : ""}
      </TooltipContent>
    </Tooltip>
  )
}

function latestReasoningEffort(userStory?: UserStory) {
  const runs = userStory?.agentRuns ?? []
  const latest = [...runs]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)
  return latest?.reasoningEffort ?? undefined
}

type SessionUsageState = {
  loading?: boolean
  sessionId?: string
  totals?: AgentUsageTotals
}

// Stories saved before usage was stored ask the agent session for it.
function useSessionUsage(
  sessionId: string | null | undefined
): SessionUsageState {
  const platform = usePlatform()
  const [state, setState] = React.useState<SessionUsageState>({})

  React.useEffect(() => {
    const agent = platform.agent
    if (!agent || !sessionId) return

    let active = true
    void agent.sessions
      .usage(sessionId)
      .then((summary) => {
        if (active) setState({ sessionId, totals: usageTotals(summary) })
      })
      .catch(() => {
        if (active) setState({ sessionId })
      })
    return () => {
      active = false
    }
  }, [platform.agent, sessionId])

  if (!platform.agent || !sessionId) return {}
  return { ...state, loading: state.sessionId !== sessionId }
}

function usageTotals(summary: AgentUsageSummary | undefined) {
  return summary?.aggregateUsage ?? summary?.usage
}

function modelContextLimit(
  userStory: UserStory | undefined,
  providers: ReturnType<typeof useModelSelection>["allProviders"]
) {
  const provider = providers.find(
    (item) => item.id === userStory?.agentProviderId
  )
  const model = provider?.models[userStory?.agentModelId ?? ""]
  return model?.contextWindow ?? provider?.models.custom?.contextWindow
}

function usageTotalsFromAgentUsage(usage: UserStory["agentUsage"]) {
  if (!usage) return undefined
  return {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cost: usage.cost,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalCacheReadTokens: usage.totalCacheReadTokens,
    totalCacheWriteTokens: usage.totalCacheWriteTokens,
    totalCost: usage.totalCost,
    totalInputTokens: usage.totalInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
  }
}

function formatCurrency(value: number | null | undefined) {
  if (value === undefined || value === null) return "—"
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: value < 1 ? 3 : 2,
    style: "currency",
  }).format(value)
}
