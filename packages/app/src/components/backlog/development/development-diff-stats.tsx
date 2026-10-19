import { CountUp } from "@/components/shared/count-up"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { DiffStatsValue } from "@/components/backlog/development/development-diff-stats-data"

export function DiffStats({
  className,
  compact = false,
  diff,
}: {
  className?: string
  compact?: boolean
  diff: DiffStatsValue
}) {
  return compact ? (
    <CompactDiffStats className={className} diff={diff} />
  ) : (
    <BadgedDiffStats className={className} diff={diff} />
  )
}

function CompactDiffStats({
  className,
  diff,
}: {
  className?: string
  diff: DiffStatsValue
}) {
  return (
    <span
      className={cn(
        "ml-auto flex shrink-0 items-center gap-1 text-xs font-medium tabular-nums",
        className
      )}
    >
      <span className="text-emerald-600 dark:text-emerald-400">
        +<CountUp value={diff.additions ?? 0} />
      </span>
      <span className="text-destructive">-<CountUp value={diff.deletions ?? 0} /></span>
    </span>
  )
}

function BadgedDiffStats({
  className,
  diff,
}: {
  className?: string
  diff: DiffStatsValue
}) {
  return (
    <span className={cn("ml-auto flex shrink-0 items-center gap-1", className)}>
      <DiffStatBadge tone="addition" value={diff.additions ?? 0} />
      <DiffStatBadge tone="deletion" value={diff.deletions ?? 0} />
    </span>
  )
}

function DiffStatBadge({
  tone,
  value,
}: {
  tone: "addition" | "deletion"
  value: number
}) {
  const addition = tone === "addition"
  return (
    <Badge
      className={cn(
        "h-5 px-1.5 tabular-nums",
        addition
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "border-destructive/30 bg-destructive/10 text-destructive"
      )}
      variant="outline"
    >
      {addition ? "+" : "-"}
      <CountUp value={value} />
    </Badge>
  )
}
