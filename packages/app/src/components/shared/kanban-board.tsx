import { CountUp } from "@/components/shared/count-up"
import type { ReactNode, Ref } from "react"

import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

type KanbanBoardProps = {
  children: ReactNode
  className?: string
  gridClassName?: string
}

export function KanbanBoard({
  children,
  className,
  gridClassName,
}: KanbanBoardProps) {
  return (
    <div
      className={cn(
        "min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden",
        className
      )}
    >
      <div
        className={cn(
          "grid h-full auto-rows-[minmax(0,1fr)] gap-3 px-px pt-px pb-3",
          gridClassName
        )}
      >
        {children}
      </div>
    </div>
  )
}

type KanbanColumnProps = {
  children: ReactNode
  // Greyed out while a dragged item cannot go here.
  dimmed?: boolean
  header: ReactNode
  // Drawn over the column's content (drop zones while dragging).
  overlay?: ReactNode
  viewportRef?: Ref<HTMLDivElement>
}

export function KanbanColumn({
  children,
  dimmed = false,
  header,
  overlay,
  viewportRef,
}: KanbanColumnProps) {
  return (
    <section
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-foreground/10 bg-foreground/3 transition-[opacity,filter] duration-200 ease-out dark:bg-neutral-900",
        dimmed && "opacity-40 grayscale"
      )}
      data-dimmed={dimmed || undefined}
    >
      {header}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollArea
          className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!"
          viewportRef={viewportRef}
        >
          <div className="flex flex-col gap-2.5 p-2.5">{children}</div>
        </ScrollArea>
        {overlay}
      </div>
    </section>
  )
}

type KanbanColumnHeaderProps = {
  title: string
  description: string
  count: number
  color: string
  children?: ReactNode
}

export function KanbanColumnHeader({
  title,
  description,
  count,
  color,
  children,
}: KanbanColumnHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-foreground/8 bg-popover/55 px-3.5 py-3 dark:bg-neutral-800">
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "mt-1.5 size-2.5 shrink-0 rounded-full border-2",
            color
          )}
        />
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{title}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {description}
          </p>
          {children}
        </div>
      </div>
      <Badge
        variant="secondary"
        className="min-w-6 rounded-md border-foreground/8 bg-foreground/5 px-1.5 text-muted-foreground tabular-nums"
      >
        <CountUp value={count} />
      </Badge>
    </div>
  )
}
