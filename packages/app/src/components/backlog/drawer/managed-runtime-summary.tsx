import * as React from "react"
import type { UserStoryPreviewRunner } from "@/components/backlog/drawer/use-user-story-preview-runner"

export function ManagedRuntimeSummary({
  runner,
}: {
  runner: UserStoryPreviewRunner
}) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!runner.usageActive) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [runner.usageActive])
  if (runner.profile === "local-container") return null
  const sampledSeconds = runner.usage?.activeSeconds ?? 0
  const observedAt = runner.usage?.observedAt
    ? Date.parse(runner.usage.observedAt)
    : Number.NaN
  const liveSeconds =
    runner.usageActive && Number.isFinite(observedAt)
      ? Math.max(0, Math.floor((now - observedAt) / 1000))
      : 0
  const seconds = sampledSeconds + liveSeconds
  const duration =
    seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${seconds}s`
  const cost = runner.usage?.estimatedCostUsd ?? 0
  return (
    <div
      className="pointer-events-auto shrink-0 rounded-full border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap text-muted-foreground shadow-sm"
      title="Managed preview profile, provisioned time, and estimated infrastructure cost"
    >
      <span className="preview-runtime-summary-label">Cloud preview · </span>
      {`${duration} · $${cost.toFixed(6)}`}
    </div>
  )
}
