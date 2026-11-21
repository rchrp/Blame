import type { PlanProgress } from "@blame/engine-client/transcript"

import { cn } from "@/lib/utils"

import { planCount } from "./plan-model.ts"

/**
 * Where the agent's plan stands, in a line, for the places that show no list.
 * `step` adds the step in hand (a story's card); without it the line is the
 * count alone (the drawer's header, where other text sits beside it). A
 * `working` dot breathes; one that waits (the agent stopped with steps open)
 * is still.
 */
export function PlanProgressLine({
  className,
  progress,
  step = false,
  working = true,
}: {
  className?: string
  progress: PlanProgress
  step?: boolean
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
    >
      <span className="grid size-3 shrink-0 place-items-center">
        <span aria-hidden className="plan-step-mark" data-working={working} />
      </span>
      <span className="shrink-0 font-medium text-foreground/80 tabular-nums">
        {planCount(progress)}
      </span>
      {step && progress.current ? (
        <span className="min-w-0 truncate">{progress.current}</span>
      ) : null}
    </span>
  )
}
