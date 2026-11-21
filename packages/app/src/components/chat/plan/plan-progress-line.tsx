import type { PlanProgress } from "@blame/engine-client/transcript"

import { cn } from "@/lib/utils"

import { planCount } from "./plan-model.ts"

/**
 * Where the agent's plan stands, in a line: the count and the step in hand.
 * For the places that show no list: a story's card, the drawer's header.
 */
export function PlanProgressLine({
  className,
  progress,
  working = true,
}: {
  className?: string
  progress: PlanProgress
  working?: boolean
}) {
  const label = progress.current
    ? `Plan: ${progress.done} of ${progress.total} done, now ${progress.current}`
    : `Plan: ${progress.done} of ${progress.total} done`
  return (
    <span
      aria-label={label}
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
        className
      )}
      role="img"
      title={label}
    >
      <span className="grid size-3 shrink-0 place-items-center">
        <span aria-hidden className="plan-step-mark" data-working={working} />
      </span>
      <span className="shrink-0 font-medium text-foreground/80 tabular-nums">
        {planCount(progress)}
      </span>
      {progress.current ? (
        <span className="min-w-0 truncate">{progress.current}</span>
      ) : null}
    </span>
  )
}
