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
  type ContextLimitOption,
  contextLimitOptions,
  effectiveContextLimit,
  modelInputLimit,
  providerInputLimit,
} from "@/components/model/context-limits"
import {
  saveStoryContextLimit,
  useStoryContextLimit,
} from "@/components/backlog/data/story-context-limit"
import { useStoryModelChoice } from "@/components/backlog/data/story-model-choice"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select"
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
  const budget = useStoryContextBudget(userStory)
  const totals =
    usageTotalsFromAgentUsage(userStory?.agentUsage) ?? sessionUsage.totals
  const context = storyContextUsage(userStory?.agentUsage, budget.limit)

  return (
    <aside className="grid gap-4 p-4">
      <ModelHeader userStory={userStory} />
      <ContextGauge budget={budget} context={context} />
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
  budget,
  context,
}: {
  budget: StoryContextBudget
  context?: StoryContextUsage
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
        <span className="flex items-baseline gap-1 text-xs text-muted-foreground tabular-nums">
          {context ? (
            <>
              <span className="text-sm font-semibold text-foreground">
                {Math.round(ratio * 100)}%
              </span>
              · {compactTokens(context.used)} /
            </>
          ) : null}
          <ContextLimitSelect budget={budget} />
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
      {budget.experimental ? (
        <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-pretty text-amber-700 dark:text-amber-300">
          Experimental: past this provider's usual limit. It uses your quota
          faster, the provider may still cut it shorter, and very long contexts
          can lower quality.
        </p>
      ) : null}
    </section>
  )
}

type StoryContextBudget = {
  // The cap the person picked, when any.
  choice?: number
  experimental: boolean
  // The budget the agent works in: the cap, or the provider's limit.
  limit?: number
  options: ContextLimitOption[]
  storyId?: string
}

// The context budget of the story's next turns: the model it will use, the
// provider's own input limit, and the cap picked for it.
function useStoryContextBudget(userStory?: UserStory): StoryContextBudget {
  const selection = useModelSelection()
  const choiceOfModel = useStoryModelChoice(userStory)
  const choice = useStoryContextLimit(userStory?.id)
  const provider = selection.allProviders.find(
    (item) => item.id === choiceOfModel?.providerId
  )
  const model = provider?.models[choiceOfModel?.modelId ?? ""]
  const providerLimit = providerInputLimit(model)
  const modelLimit = modelInputLimit(model, selection.allProviders)
  const limit = effectiveContextLimit(choice, modelLimit) ?? providerLimit
  return {
    choice,
    experimental: Boolean(limit && providerLimit && limit > providerLimit),
    limit,
    options: contextLimitOptions(providerLimit, modelLimit),
    storyId: userStory?.id,
  }
}

const providerDefault = "provider"

// The cap, picked where it is read: next to the context it limits.
function ContextLimitSelect({ budget }: { budget: StoryContextBudget }) {
  const storyId = budget.storyId
  if (!budget.limit) return null
  if (!storyId || budget.options.length < 2)
    return <span>{compactTokens(budget.limit)}</span>
  const selected =
    budget.options.find((option) => option.value === budget.choice) ??
    budget.options.find((option) => option.value === undefined)
  const standard = budget.options.filter((option) => !option.experimental)
  const experimental = budget.options.filter((option) => option.experimental)
  return (
    <Select
      value={selected?.value ? String(selected.value) : providerDefault}
      onValueChange={(value) =>
        saveStoryContextLimit(
          storyId,
          value === providerDefault ? undefined : Number(value)
        )
      }
    >
      <SelectTrigger
        aria-label="Maximum context"
        className="h-auto gap-0.5 border-0 bg-transparent p-0 text-xs text-muted-foreground shadow-none hover:text-foreground focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent [&_svg:not([class*='size-'])]:size-3"
        size="sm"
      >
        {compactTokens(budget.limit)}
      </SelectTrigger>
      <SelectContent align="end" className="min-w-48" position="popper">
        <SelectGroup>
          <SelectLabel>Max context · from the next message</SelectLabel>
          {standard.map((option) => (
            <SelectItem
              key={option.value ?? providerDefault}
              value={option.value ? String(option.value) : providerDefault}
            >
              {compactTokens(option.tokens)}
              {option.value === undefined ? (
                <span className="text-muted-foreground">Provider limit</span>
              ) : null}
            </SelectItem>
          ))}
        </SelectGroup>
        {experimental.length ? (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Experimental</SelectLabel>
              {experimental.map((option) => (
                <SelectItem key={option.tokens} value={String(option.value)}>
                  {compactTokens(option.tokens)}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        ) : null}
      </SelectContent>
    </Select>
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
