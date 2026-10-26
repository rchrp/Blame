import * as React from "react"
import type {
  SubscriptionUsage,
  SubscriptionUsageWindow,
} from "@blame/agent-runtime"

import {
  type ModelSelection,
  subscriptionProviders,
} from "@/components/model/model-selection"
import { cn } from "@/lib/utils"

const refreshMs = 60_000

export function hasPlanUsage(providerId: string | undefined) {
  return !!providerId && subscriptionProviders.includes(providerId)
}

/**
 * How much of the user's ChatGPT or Claude plan is used, kept fresh while
 * shown. `refreshKey` asks again when it changes, after an agent turn.
 */
export function usePlanUsage(
  selection: ModelSelection,
  providerId: string | undefined,
  refreshKey?: unknown,
  preferredCredentialLabel?: string
) {
  const read = selection.agent?.providers.subscriptionUsage
  const credentialLabel =
    preferredCredentialLabel ??
    (providerId ? selection.selectedAccountLabel(providerId) : undefined)
  const apiConnection = selection.apiConnection
  const connected = !!providerId && selection.connectedProviderIDs.has(providerId)
  const enabled = !!read && connected && hasPlanUsage(providerId)
  const [result, setResult] = React.useState<{
    apiConnection: typeof apiConnection
    credentialLabel?: string
    failed: boolean
    providerId: string
    usage?: SubscriptionUsage | null
  }>()

  React.useEffect(() => {
    if (!enabled || !providerId) return
    let active = true
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      const identity = { apiConnection, credentialLabel, providerId }
      try {
        const usage = await read(identity)
        if (active) setResult({ ...identity, failed: false, usage })
      } catch {
        if (active) setResult({ ...identity, failed: true })
      } finally {
        inFlight = false
      }
    }
    const run = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    const first = window.setTimeout(run, 0)
    const timer = window.setInterval(run, refreshMs)
    window.addEventListener("focus", run)
    return () => {
      active = false
      window.clearTimeout(first)
      window.clearInterval(timer)
      window.removeEventListener("focus", run)
    }
  }, [apiConnection, credentialLabel, enabled, providerId, read, refreshKey])

  // A slow response from the previous provider/account must never be shown
  // beside the newly selected model.
  const current =
    enabled &&
    result?.apiConnection === apiConnection &&
    result?.providerId === providerId &&
    result?.credentialLabel === credentialLabel
      ? result
      : undefined
  return { enabled, failed: current?.failed ?? false, usage: current?.usage }
}

/** One bar per plan window, each with its reset time. */
export function PlanUsageBars({
  className,
  usage,
}: {
  className?: string
  usage: SubscriptionUsage
}) {
  return (
    <div className={cn("grid gap-2.5", className)}>
      {usage.windows.map((window) => (
        <PlanUsageBar key={window.id} window={window} />
      ))}
    </div>
  )
}

function PlanUsageBar({ window }: { window: SubscriptionUsageWindow }) {
  const reset = resetText(window)
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs tabular-nums">
        <span className="text-muted-foreground">{window.label}</span>
        <span className="font-medium text-foreground">
          {window.usedPercent}%{" "}
          <span className="font-normal text-muted-foreground">used</span>
        </span>
      </div>
      <div
        aria-label={`${window.label}: ${window.usedPercent}% used`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={window.usedPercent}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]"
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
        <span className="text-[11px] text-muted-foreground">{reset}</span>
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
