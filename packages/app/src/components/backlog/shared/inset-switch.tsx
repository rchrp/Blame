import type { LucideIcon } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// A few views sitting in a recess of a toolbar group: a switch whose knob
// slides to the one showing. The runner's Preview, Run logs and Variables
// use it, and the Code tab's Files, Changes and Terminal.
export type InsetSwitchItem = {
  id: string
  icon: LucideIcon
  label: string
  active?: boolean
  // Something to see there now: a blue dot, selected or not.
  ready?: boolean
  // Shown while not selected; the label otherwise.
  tooltip?: string
  // Why the view cannot show now.
  unavailable?: string
  onSelect: () => void
}

const step = "(1.75rem + 0.125rem)"

// The look of the group the switch sits in.
export const insetSwitchGroupClassName = "rounded-lg border bg-muted p-0.5"

export function InsetSwitch({
  className,
  items,
}: {
  className?: string
  items: InsetSwitchItem[]
}) {
  const active = items.findIndex((item) => item.active)
  return (
    <div
      className={cn(
        "relative flex items-center gap-0.5 rounded-md! bg-foreground/[0.07] p-0.5 shadow-[inset_0_1px_2px_rgb(0_0_0/0.16)] dark:bg-black/35 dark:shadow-[inset_0_1px_3px_rgb(0_0_0/0.45)]",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-0.5 left-0.5 size-7 rounded-[5px] border border-transparent bg-background shadow-sm transition-[translate,opacity] duration-200 ease-out motion-reduce:transition-none dark:border-white/10 dark:bg-muted",
          active < 0 && "opacity-0"
        )}
        style={{ translate: `calc(${Math.max(active, 0)} * ${step}) 0` }}
      />
      {items.map((item) => (
        <InsetSwitchButton key={item.id} item={item} />
      ))}
    </div>
  )
}

function InsetSwitchButton({ item }: { item: InsetSwitchItem }) {
  const Icon = item.icon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no pointer events: its tooltip needs one. */}
        <span className="relative inline-flex">
          <Button
            aria-label={item.ready ? `${item.label}, ready` : item.label}
            aria-pressed={Boolean(item.active)}
            className={cn(
              "relative size-7 rounded-[5px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground dark:hover:bg-white/5",
              item.active &&
                "text-foreground hover:bg-transparent dark:hover:bg-transparent"
            )}
            disabled={Boolean(item.unavailable)}
            size="icon"
            type="button"
            variant="ghost"
            onClick={item.onSelect}
          >
            <Icon />
            {item.ready ? (
              <span
                aria-hidden="true"
                className="absolute top-1 right-1 size-1.5 rounded-full bg-sky-500 shadow-[0_0_0_1.5px_var(--muted)]"
              />
            ) : null}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {item.unavailable ??
          (item.active ? item.label : (item.tooltip ?? item.label))}
      </TooltipContent>
    </Tooltip>
  )
}

// The width of an element, kept current: toolbars leave room for the
// controls floating over their right end.
export function useElementWidth<T extends HTMLElement>() {
  const [element, setElement] = React.useState<T | null>(null)
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.ceil(entry?.borderBoxSize[0]?.inlineSize ?? 0))
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, width] as const
}
