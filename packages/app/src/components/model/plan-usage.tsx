import * as React from "react"
import type {
  SubscriptionUsage,
  SubscriptionUsageWindow,
} from "@blame/agent-runtime"

import {
  type ModelSelection,
  subscriptionProviders,
} from "@/components/model/model-selection"
import { planUsageKey, planUsages } from "@/components/model/plan-usage-cache"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useCloudAuth } from "@/context/cloud-auth"
import { cn } from "@/lib/utils"

export function hasPlanUsage(providerId: string | undefined) {
  return !!providerId && subscriptionProviders.includes(providerId)
}

/**
 * How much of the user's ChatGPT or Claude plan is used. The value is shared
 * by everything that shows it and kept fresh while one is shown. When the
 * `agent` stops running, its turn just used some of the plan: ask again once.
 */
export function usePlanUsage(
  selection: ModelSelection,
  providerId: string | undefined,
  agent?: { id: string; running: boolean },
  preferredCredentialLabel?: string
) {
  const user = useCloudAuth().user
  const read = selection.agent?.providers.subscriptionUsage
  const credentialLabel =
    preferredCredentialLabel ??
    (providerId ? selection.selectedAccountLabel(providerId) : undefined)
  const apiConnection = selection.apiConnection
  const connected = !!providerId && selection.connectedProviderIDs.has(providerId)
  const enabled = !!read && connected && hasPlanUsage(providerId)
  // One entry per account: a slow answer for another provider or account can
  // never be shown beside the newly selected model.
  const key =
    enabled && providerId
      ? planUsageKey(
          `${apiConnection.url}|${user?.id ?? ""}`,
          providerId,
          credentialLabel
        )
      : undefined
  const fetchUsage = React.useMemo(
    () =>
      read && providerId
        ? () => read({ apiConnection, credentialLabel, providerId })
        : undefined,
    [apiConnection, credentialLabel, providerId, read]
  )
  const entry = React.useSyncExternalStore(
    planUsages.subscribe,
    () => planUsages.read(key),
    () => undefined
  )

  React.useEffect(() => {
    if (!key || !fetchUsage) return
    return planUsages.watch(key, fetchUsage)
  }, [fetchUsage, key])

  // The turn that just ended used some of the plan: ask once more, now.
  const agentId = agent?.id
  const agentRunning = agent?.running ?? false
  const previousAgent = React.useRef({ id: agentId, running: agentRunning })
  React.useEffect(() => {
    const previous = previousAgent.current
    previousAgent.current = { id: agentId, running: agentRunning }
    const turnEnded =
      previous.id === agentId && previous.running && !agentRunning
    if (turnEnded && key && fetchUsage) {
      void planUsages.load(key, fetchUsage, { force: true })
    }
  }, [agentId, agentRunning, fetchUsage, key])

  return {
    enabled,
    failed: entry?.failed ?? false,
    usage: entry && !entry.failed ? entry.usage : undefined,
  }
}

/**
 * One bar per plan window, each with its reset time. `inverted` is for a
 * tooltip, whose colors are the page's swapped.
 */
export function PlanUsageBars({
  className,
  inverted = false,
  usage,
}: {
  className?: string
  inverted?: boolean
  usage: SubscriptionUsage
}) {
  return (
    <div className={cn("grid gap-2.5", className)}>
      {usage.windows.map((window) => (
        <PlanUsageBar key={window.id} inverted={inverted} window={window} />
      ))}
    </div>
  )
}

function PlanUsageBar({
  inverted,
  window,
}: {
  inverted: boolean
  window: SubscriptionUsageWindow
}) {
  const reset = resetText(window)
  const muted = inverted ? "text-background/60" : "text-muted-foreground"
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs tabular-nums">
        <span className={muted}>{window.label}</span>
        <span
          className={cn(
            "font-medium",
            inverted ? "text-background" : "text-foreground"
          )}
        >
          {window.usedPercent}%{" "}
          <span className={cn("font-normal", muted)}>used</span>
        </span>
      </div>
      <div
        aria-label={`${window.label}: ${window.usedPercent}% used`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={window.usedPercent}
        className={cn(
          "h-1.5 overflow-hidden rounded-full",
          inverted ? "bg-background/15" : "bg-foreground/[0.08]"
        )}
        role="progressbar"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            usageTone(window.usedPercent)
          )}
          style={{ width: `${Math.max(window.usedPercent, 2)}%` }}
        />
      </div>
      {reset ? (
        <span className={cn("text-[11px]", muted)}>{reset}</span>
      ) : null}
    </div>
  )
}

function usageTone(usedPercent: number) {
  if (usedPercent >= 90) return "bg-rose-500"
  if (usedPercent >= 70) return "bg-amber-500"
  return "bg-blue-500"
}

function resetText(window: SubscriptionUsageWindow) {
  if (window.resetsAt) {
    const minutes = Math.max(0, Math.round((window.resetsAt - Date.now()) / 60_000))
    if (minutes < 1) return "Resets now"
    if (minutes < 60) return `Resets in ${minutes} min`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `Resets in ${hours} h ${minutes % 60} min`
    const days = Math.round(hours / 24)
    return `Resets in ${days} day${days === 1 ? "" : "s"}`
  }
  if (window.resetsLabel)
    return `Resets ${window.resetsLabel.replace(/\s*\([^)]*\)$/, "")}`
  return undefined
}

/**
 * Both plan windows on one ring: the longer arc underneath, the shorter on
 * top. Each arc warms from blue to red as its window nears the limit.
 */
export function PlanUsageDonut({ usage }: { usage: SubscriptionUsage }) {
  const size = 28
  const stroke = 4
  const radius = (size - stroke) / 2
  const length = 2 * Math.PI * radius
  const windows = shownWindows(usage)
  const highest = Math.max(0, ...windows.map((window) => window.usedPercent))
  const arcs = windows
    .map((window, index) => ({ window, lightness: index === 0 ? 0.64 : 0.8 }))
    .sort((left, right) => right.window.usedPercent - left.window.usedPercent)
  return (
    <svg
      aria-hidden
      className="size-7 shrink-0 -rotate-90"
      viewBox={`0 0 ${size} ${size}`}
    >
      <circle
        className={cn(
          "transition-colors duration-500",
          highest >= 80 ? "stroke-rose-500/25" : "stroke-foreground/[0.09]"
        )}
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={radius}
        strokeWidth={stroke}
      />
      {arcs.map(({ lightness, window }) => (
        <circle
          key={window.id}
          className="transition-[stroke-dasharray,stroke] duration-500 ease-out"
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke={usageColor(window.usedPercent, lightness)}
          strokeDasharray={`${(Math.max(window.usedPercent, 1) / 100) * length} ${length}`}
          strokeLinecap="round"
          strokeWidth={stroke}
        />
      ))}
    </svg>
  )
}

/** The two percentages beside the donut, each with its window. */
export function PlanUsagePercents({ usage }: { usage: SubscriptionUsage }) {
  return (
    <span className="grid gap-0.5 text-left leading-none tabular-nums">
      {shownWindows(usage).map((window, index) => (
        <span key={window.id} className="flex items-baseline gap-1">
          <span
            className={cn(
              "font-semibold",
              index === 0 ? "text-xs" : "text-[10px]"
            )}
            style={{ color: usageColor(window.usedPercent, index === 0 ? 0.64 : 0.8) }}
          >
            {window.usedPercent}%
          </span>
          <span className="text-[10px] text-muted-foreground">
            {shortWindowLabel(window)}
          </span>
        </span>
      ))}
    </span>
  )
}

/**
 * The donut and its two percentages, with every window's bar and reset time
 * on hover or focus. Needs a TooltipProvider above it.
 */
export function PlanUsageGlance({
  className,
  side = "bottom",
  usage,
}: {
  className?: string
  side?: React.ComponentProps<typeof TooltipContent>["side"]
  usage: SubscriptionUsage
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={`Plan usage: ${planUsageSummary(usage)}`}
          className={cn(
            "flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            className
          )}
        >
          <PlanUsageDonut usage={usage} />
          <PlanUsagePercents usage={usage} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="block w-56" side={side}>
        <PlanUsageBars inverted usage={usage} />
      </TooltipContent>
    </Tooltip>
  )
}

export function planUsageSummary(usage: SubscriptionUsage) {
  return shownWindows(usage)
    .map((window) => `${window.label} ${window.usedPercent}%`)
    .join(" · ")
}

// The short window first (5 hours), then the long one (week).
function shownWindows(usage: SubscriptionUsage) {
  return [...usage.windows]
    .sort(
      (left, right) =>
        windowOrder(left) - windowOrder(right) ||
        (left.windowMinutes ?? 0) - (right.windowMinutes ?? 0)
    )
    .slice(0, 2)
}

function windowOrder(window: SubscriptionUsageWindow) {
  if (window.id === "five_hour" || window.id === "primary") return 0
  if (window.id === "seven_day" || window.id === "secondary") return 1
  return 2
}

function shortWindowLabel(window: SubscriptionUsageWindow) {
  if (window.label === "5 hours") return "5h"
  if (window.label === "Week") return "week"
  return window.label.toLowerCase()
}

/** Blue while there is room, then through violet to red near the limit. */
function usageColor(usedPercent: number, lightness: number) {
  const warmth = Math.min(1, Math.max(0, (usedPercent - 40) / 55))
  const hue = (255 + warmth * 130) % 360
  const chroma = 0.17 + warmth * 0.05
  return `oklch(${lightness} ${chroma.toFixed(3)} ${hue.toFixed(0)})`
}
