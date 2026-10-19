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
          // pt-px keeps the columns' 1px ring from being clipped at the top.
          "grid h-full auto-rows-[minmax(0,1fr)] gap-3 pt-px pb-3",
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
  header: ReactNode
  viewportRef?: Ref<HTMLDivElement>
}

export function KanbanColumn({
  children,
  header,
  viewportRef,
}: KanbanColumnProps) {
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-muted/30 shadow-xl ring-1 shadow-black/10 ring-foreground/15">
      {header}
      <ScrollArea
        className="min-h-0 flex-1 bg-foreground/5 dark:bg-background [&_[data-slot=scroll-area-viewport]>div]:block!"
        viewportRef={viewportRef}
      >
        <div className="flex flex-col gap-3 p-3">{children}</div>
      </ScrollArea>
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
    <div className="flex items-start justify-between gap-3 border-b bg-muted/30 p-4">
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className={cn("mt-1.5 size-3 shrink-0 rounded-full border-2", color)}
        />
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{title}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {description}
          </p>
          {children}
        </div>
      </div>
      <Badge variant="secondary" className="tabular-nums">
        <CountUp value={count} />
      </Badge>
    </div>
  )
}
