import * as React from "react"

import { cn } from "@/lib/utils"

// Composer pickers joined into one pill, split by a thin straight gap. Every
// segment has the same height whatever its state (chosen, locked, tinted).
export function SelectorGroup({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="selector-group"
      className={cn(
        "flex h-8 max-w-full min-w-0 shrink-0 items-stretch justify-end gap-0.5",
        className
      )}
      {...props}
    />
  )
}

// Rounds only the outer corners, so a lone segment is a full pill.
export const selectorSegmentClassName =
  "flex h-8 min-w-0 items-center justify-between gap-2 rounded-none border-0 bg-muted/70 px-3 text-sm font-medium text-foreground shadow-none outline-none transition-colors first:rounded-l-xl last:rounded-r-xl hover:bg-muted focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring/50 active:translate-y-0 aria-expanded:bg-muted dark:hover:bg-muted disabled:pointer-events-none disabled:opacity-50"

export const selectorChevronClassName = "size-4 shrink-0 text-muted-foreground"
