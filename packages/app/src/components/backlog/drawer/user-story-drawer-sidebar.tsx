import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
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
  PlanUsageBars,
  PlanUsageDonut,
  PlanUsagePercents,
  planUsageSummary,
  usePlanUsage,
} from "@/components/model/plan-usage"
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
import {
  CompactContextButton,
  compactionNote,
  type StoryContextCompaction,
  useStoryContextCompaction,
} from "@/components/backlog/drawer/story-context-compaction"
import { cn } from "@/lib/utils"

// The story's agent at a glance, floating at the top right of the drawer:
// the full panel, or a small pill with the context donut.
export function StoryStatsIsland({
  contextLimitKey,
  diffStats,
  expanded,
  onExpand,
  preparing = false,
  useEditorModel = false,
  userStory,
}: {
  contextLimitKey?: string
  diffStats?: UserStoryDiffStats
  expanded: boolean
  onExpand(): void
  preparing?: boolean
  useEditorModel?: boolean
  userStory?: UserStory
}) {
  const stats = useStoryStats(userStory, contextLimitKey, useEditorModel)
  const reduceMotion = useReducedMotion()
  // The full face stays mounted so the island always knows its height and
  // can move between two known sizes.
  const fullFaceRef = React.useRef<HTMLDivElement>(null)
  const [fullHeight, setFullHeight] = React.useState<number>()
  React.useLayoutEffect(() => {
    const face = fullFaceRef.current
    if (!face) return
    const observer = new ResizeObserver(() =>
      setFullHeight(Math.ceil(face.getBoundingClientRect().height))
    )
    observer.observe(face)
    return () => observer.disconnect()
  }, [])
  // Until it is measured, the full face sizes the island itself.
  const fullFaceInFlow = expanded && fullHeight === undefined
  return (
    <motion.div
      className="absolute top-4 right-4 z-20 max-w-[calc(100%-2rem)] overflow-hidden rounded-xl bg-input/40 shadow-xl ring-1 shadow-black/10 ring-foreground/20 backdrop-blur-xl dark:bg-muted"
      initial={false}
      animate={
        expanded
          ? { height: fullHeight ?? "auto", width: expandedWidth }
          : { height: compactHeight, width: pillWidth(stats) }
      }
      transition={islandTransition(expanded, reduceMotion)}
    >
      <IslandFace
        className={cn(!fullFaceInFlow && "absolute top-0 right-0")}
        revealDelay={0.26}
        shown={expanded}
      >
        <div
          ref={fullFaceRef}
          className="max-h-[calc(100svh-6rem)] overflow-y-auto"
          style={{ width: expandedWidth }}
        >
          <DrawerSidebar
            diffStats={diffStats}
            stats={stats}
            userStory={userStory}
          />
        </div>
      </IslandFace>
      <IslandFace
        className="absolute top-0 right-0"
        revealDelay={0.5}
        shown={!expanded && !preparing}
      >
        <CompactStats diffStats={diffStats} stats={stats} onExpand={onExpand} />
      </IslandFace>
      <IslandFace
        className="absolute top-0 right-0"
        revealDelay={0.5}
        shown={preparing}
      >
        <PreparationStats stats={stats} />
      </IslandFace>
    </motion.div>
  )
}

const expandedWidth = 320
const compactWidth = 192
// Room for the plan usage donut and its two percentages.
const planUsageWidth = 92

function pillWidth(stats: StoryStats) {
  return compactWidth + (stats.planUsage ? planUsageWidth : 0)
}
const compactHeight = 48

const islandEase = [0.32, 0.72, 0, 1] as const

// Opening, the island widens, then grows down; closing, the other way.
function islandTransition(expanded: boolean, reduceMotion: boolean | null) {
  if (reduceMotion) return { duration: 0 }
  return expanded
    ? {
        height: { delay: 0.22, duration: 0.4, ease: islandEase },
        width: { duration: 0.3, ease: islandEase },
      }
    : {
        height: { delay: 0.08, duration: 0.3, ease: islandEase },
        width: { delay: 0.3, duration: 0.3, ease: islandEase },
      }
}

// One face of the island. Its parts pop in one after another once the
// island makes room for them, and all leave at once.
function IslandFace({
  children,
  className,
  revealDelay,
  shown,
}: {
  children: React.ReactNode
  className?: string
  revealDelay: number
  shown: boolean
}) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      aria-hidden={!shown}
      className={cn(!shown && "pointer-events-none", className)}
      inert={!shown}
      initial={false}
      animate={shown ? "shown" : "hidden"}
      variants={{
        hidden: {},
        shown: {
          transition: reduceMotion
            ? {}
            : { delayChildren: revealDelay, staggerChildren: 0.045 },
        },
      }}
    >
      {children}
    </motion.div>
  )
}

const popVariants = {
  hidden: {
    opacity: 0,
    scale: 0.94,
    transition: { duration: 0.12, ease: "easeIn" },
    y: -6,
  },
  shown: {
    opacity: 1,
    scale: 1,
    transition: { bounce: 0.35, duration: 0.45, type: "spring" },
    y: 0,
  },
} as const

// A part of a face, popping in its turn.
function Pop({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <motion.div className={className} variants={popVariants}>
      {children}
    </motion.div>
  )
}

type StoryStats = ReturnType<typeof useStoryStats>

function useStoryStats(
  userStory: UserStory | undefined,
  contextLimitKey: string | undefined,
  useEditorModel: boolean
) {
  const sessionUsage = useSessionUsage(
    userStory?.agentUsage ? undefined : userStory?.clineSessionId
  )
  const selection = useModelSelection()
  const choiceOfModel = useStoryModelChoice(useEditorModel ? undefined : userStory)
  const provider = choiceOfModel
    ? selection.allProviders.find((item) => item.id === choiceOfModel.providerId)
    : selection.currentModel?.provider
  const model = choiceOfModel
    ? provider?.models[choiceOfModel.modelId]
    : selection.currentModel
  const budget = useStoryContextBudget(
    contextLimitKey ?? userStory?.id,
    model,
    selection.allProviders
  )
  const compaction = useStoryContextCompaction(userStory)
  const totals =
    usageTotalsFromAgentUsage(userStory?.agentUsage) ?? sessionUsage.totals
  const context = storyContextUsage(userStory?.agentUsage, budget.limit)
  const plan = usePlanUsage(
    selection,
    provider?.id,
    userStory?.agentUsage,
    choiceOfModel?.credentialLabel ?? undefined
  )
  const planUsage = (plan.enabled && plan.usage) || undefined
  return { budget, compaction, context, planUsage, totals }
}

// Before execution there is no context usage or run total to display.
// Keep the plan usage and the next run's context budget beside Close.
function PreparationStats({ stats }: { stats: StoryStats }) {
  const { budget, planUsage } = stats
  return (
    <div
      className="flex items-center gap-2 pl-2.5"
      style={{ height: compactHeight, width: pillWidth(stats) }}
    >
      {planUsage ? (
        <Pop className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-label={`Plan usage: ${planUsageSummary(planUsage)}`}
                className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <PlanUsageDonut usage={planUsage} />
                <PlanUsagePercents usage={planUsage} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <PlanUsageBars usage={planUsage} />
            </TooltipContent>
          </Tooltip>
          <span aria-hidden className="mx-0.5 h-6 w-px shrink-0 bg-foreground/10" />
        </Pop>
      ) : null}
      <Pop className="flex min-w-0 flex-1 items-center">
        <ContextLimitSelect budget={budget} compact />
        {!budget.limit ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : null}
      </Pop>
      <span aria-hidden className="w-12 shrink-0" />
    </div>
  )
}

function DrawerSidebar({
  diffStats,
  stats: { budget, compaction, context, planUsage, totals },
  userStory,
}: {
  diffStats?: UserStoryDiffStats
  stats: StoryStats
  userStory?: UserStory
}) {
  return (
    <aside className="grid gap-4 p-4">
      <ModelHeader userStory={userStory} />
      <ContextGauge budget={budget} compaction={compaction} context={context} />
      {planUsage ? <PlanUsageSection usage={planUsage} /> : null}
      <div className="grid grid-cols-3 gap-2">
        <Pop className="grid min-w-0">
          <Stat label="Cost">
            {formatCurrency(totals?.totalCost ?? totals?.cost)}
          </Stat>
        </Pop>
        <Pop className="grid min-w-0">
          <TokensStat totals={totals} />
        </Pop>
        <Pop className="grid min-w-0">
          <Stat label="Changes">
            {diffStats ? <DiffCounts diffStats={diffStats} /> : "—"}
          </Stat>
        </Pop>
      </div>
    </aside>
  )
}

// The ChatGPT or Claude plan behind the story's model, refreshed after each turn.
function PlanUsageSection({ usage }: { usage: NonNullable<StoryStats["planUsage"]> }) {
  return (
    <section className="grid gap-2.5" aria-label="Plan usage">
      <Pop className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">
          Plan usage
        </span>
        {usage.planType ? (
          <span className="text-xs text-muted-foreground capitalize">
            {usage.planType}
          </span>
        ) : null}
      </Pop>
      <Pop>
        <PlanUsageBars usage={usage} />
      </Pop>
    </section>
  )
}

function DiffCounts({ diffStats }: { diffStats: UserStoryDiffStats }) {
  return (
    <span className="flex gap-[0.4em]">
      <span className="text-emerald-600 dark:text-emerald-400">
        +{diffStats.additions}
      </span>
      <span className="text-rose-600 dark:text-rose-400">
        −{diffStats.deletions}
      </span>
    </span>
  )
}

// The pill: how full the context is and what changed, the rest on hover. The drawer's own
// toggle and close buttons sit on its right end.
function CompactStats({
  diffStats,
  onExpand,
  stats,
}: {
  diffStats?: UserStoryDiffStats
  onExpand(): void
  stats: StoryStats
}) {
  const { budget, context, planUsage, totals } = stats
  const cost = totals?.totalCost ?? totals?.cost
  return (
    <div
      className="flex items-center"
      style={{ height: compactHeight, width: pillWidth(stats) }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Show agent stats"
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-l-xl pr-1 pl-2.5 outline-none hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.06]"
            onClick={onExpand}
          >
            {planUsage ? (
              <>
                <motion.span className="flex" variants={popVariants}>
                  <PlanUsageDonut usage={planUsage} />
                </motion.span>
                <motion.span className="flex" variants={popVariants}>
                  <PlanUsagePercents usage={planUsage} />
                </motion.span>
                <motion.span
                  aria-hidden
                  className="mx-0.5 h-6 w-px shrink-0 bg-foreground/10"
                  variants={popVariants}
                />
              </>
            ) : null}
            <motion.span className="flex" variants={popVariants}>
              <ContextDonut
                ratio={context?.ratio}
                cachedRatio={context ? context.cached / context.limit : 0}
              />
            </motion.span>
            <motion.span
              className="grid gap-0.5 text-left leading-none tabular-nums"
              variants={popVariants}
            >
              <span className="text-sm font-semibold text-foreground">
                {context ? `${Math.round(context.ratio * 100)}%` : "—"}
              </span>
              {diffStats ? (
                <span className="text-[10px] font-medium">
                  <DiffCounts diffStats={diffStats} />
                </span>
              ) : null}
            </motion.span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="grid gap-0.5 tabular-nums" side="bottom">
          <span>
            Context{" "}
            {context
              ? `${compactTokens(context.used)} / ${compactTokens(context.limit)}`
              : budget.limit
                ? `· ${compactTokens(budget.limit)} max`
                : "· not started"}
          </span>
          {planUsage ? <span>Plan {planUsageSummary(planUsage)}</span> : null}
          {cost !== undefined && cost !== null ? (
            <span>Cost {formatCurrency(cost)}</span>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <span aria-hidden className="w-[5.5rem] shrink-0" />
    </div>
  )
}

// The context grid, as a ring: reused, then new, over the free part.
function ContextDonut({
  ratio = 0,
  cachedRatio = 0,
  showPressure = true,
}: {
  ratio?: number
  cachedRatio?: number
  showPressure?: boolean
}) {
  const size = 28
  const stroke = 4
  const radius = (size - stroke) / 2
  const length = 2 * Math.PI * radius
  const used = Math.max(0, Math.min(ratio, 1))
  const cached = Math.max(0, Math.min(cachedRatio, used))
  const ring = (fraction: number, className: string) => (
    <circle
      className={cn(
        "transition-[stroke-dasharray] duration-500 ease-out",
        className
      )}
      cx={size / 2}
      cy={size / 2}
      fill="none"
      r={radius}
      strokeDasharray={`${fraction * length} ${length}`}
      strokeWidth={stroke}
    />
  )
  return (
    <svg
      aria-hidden
      className="size-7 shrink-0 -rotate-90"
      viewBox={`0 0 ${size} ${size}`}
    >
      {ring(
        1,
        showPressure && used >= 0.8
          ? "stroke-amber-500/25"
          : "stroke-foreground/[0.09]"
      )}
      {ring(used, "stroke-violet-400")}
      {ring(cached, "stroke-blue-500")}
    </svg>
  )
}

function ModelHeader({ userStory }: { userStory?: UserStory }) {
  const names = useModelDisplayNames()
  const providerId = userStory?.agentProviderId
  const modelId = userStory?.agentModelId
  const effort = latestReasoningEffort(userStory)
  if (!providerId || !modelId) return null
  return (
    <Pop className="flex min-w-0 items-center gap-2 pr-[4.75rem]">
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
    </Pop>
  )
}

const contextCells = 50

function ContextGauge({
  budget,
  compaction,
  context,
}: {
  budget: StoryContextBudget
  compaction: StoryContextCompaction
  context?: StoryContextUsage
}) {
  const ratio = context?.ratio ?? 0
  const cachedCells = context
    ? Math.round((context.cached / context.limit) * contextCells)
    : 0
  const usedCells = context ? Math.max(1, Math.round(ratio * contextCells)) : 0
  return (
    <section className="grid gap-2.5" aria-label="Context window">
      <Pop className="flex items-baseline justify-between gap-3">
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
      </Pop>
      <Pop className="grid grid-cols-[repeat(25,minmax(0,1fr))] gap-[3px]">
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
      </Pop>
      {context ? (
        <Pop className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
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
        </Pop>
      ) : null}
      <Pop className="flex items-start justify-between gap-2">
        <p className="text-xs text-pretty text-muted-foreground">
          {compactionNote(compaction) ?? contextNote(context)}
        </p>
        <CompactContextButton compaction={compaction} />
      </Pop>
      {budget.experimental ? (
        <Pop className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-pretty text-amber-700 dark:text-amber-300">
          Experimental: past this provider's usual limit. It uses your quota
          faster, the provider may still cut it shorter, and very long contexts
          can lower quality.
        </Pop>
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
  maximum?: number
  options: ContextLimitOption[]
  storyId?: string
}

// The context budget of the story's next turns: the model it will use, the
// provider's own input limit, and the cap picked for it.
function useStoryContextBudget(
  storyId: string | undefined,
  model: Parameters<typeof modelInputLimit>[0],
  providers: Parameters<typeof modelInputLimit>[1]
): StoryContextBudget {
  const choice = useStoryContextLimit(storyId)
  const providerLimit = providerInputLimit(model)
  const modelLimit = modelInputLimit(model, providers)
  const limit = effectiveContextLimit(choice, modelLimit) ?? providerLimit
  return {
    choice,
    experimental: Boolean(limit && providerLimit && limit > providerLimit),
    limit,
    maximum: modelLimit,
    options: contextLimitOptions(providerLimit, modelLimit),
    storyId,
  }
}

const providerDefault = "provider"

// The cap, picked where it is read: next to the context it limits.
function ContextLimitSelect({
  budget,
  compact = false,
}: {
  budget: StoryContextBudget
  compact?: boolean
}) {
  const storyId = budget.storyId
  if (!budget.limit) return null
  const maximum = budget.maximum ?? budget.limit
  const value = compact ? (
    <>
      <ContextDonut ratio={budget.limit / maximum} showPressure={false} />
      <span className="grid gap-0.5 text-left leading-none tabular-nums">
        <span className="text-sm font-semibold text-foreground">
          {compactTokens(budget.limit)}
        </span>
        <span className="text-[10px] font-medium text-muted-foreground">
          / {compactTokens(maximum)}
        </span>
      </span>
    </>
  ) : (
    compactTokens(budget.limit)
  )
  if (!storyId || budget.options.length < 2)
    return (
      <span className={cn(compact && "flex items-center gap-2")}>{value}</span>
    )
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
        title={
          compact
            ? `Context budget: ${compactTokens(budget.limit)} of ${compactTokens(maximum)} maximum`
            : undefined
        }
        className={cn(
          "h-auto gap-0.5 border-0 bg-transparent p-0 text-xs text-muted-foreground shadow-none hover:text-foreground focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent [&_svg:not([class*='size-'])]:size-3",
          compact &&
            "gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring/50"
        )}
        size="sm"
      >
        {value}
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
