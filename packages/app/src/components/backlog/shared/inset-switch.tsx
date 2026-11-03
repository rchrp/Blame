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
// slides to the one showing. The runner's Preview, Logs and Env use it, and
// the Code tab's Files, Changes and Terminal.
export type InsetSwitchItem = {
  id: string
  icon: LucideIcon
  // One word, shown beside the icon in a labeled switch.
  label: string
  active?: boolean
  // Something to see there now: a blue dot, selected or not.
  ready?: boolean
  // Shown while not selected, in a switch of icons alone.
  tooltip?: string
  // Why the view cannot show now.
  unavailable?: string
  onSelect: () => void
}

// The look of the group the switch sits in.
export const insetSwitchGroupClassName = "rounded-lg border bg-muted p-0.5"

export function InsetSwitch({
  className,
  items,
  labeled = false,
}: {
  className?: string
  items: InsetSwitchItem[]
  labeled?: boolean
}) {
  const active = items.findIndex((item) => item.active)
  const listRef = React.useRef<HTMLDivElement>(null)
  const knobRef = React.useRef<HTMLSpanElement>(null)
  const placed = React.useRef(false)

  // The knob takes the place and the width of the selected button, which
  // differ from one label to the next; it slides only once it has a place.
  React.useLayoutEffect(() => {
    const list = listRef.current
    const knob = knobRef.current
    if (!list || !knob) return
    const place = () => {
      const button = list.querySelector<HTMLElement>(
        "[data-inset-switch-item][data-active]"
      )
      knob.style.opacity = button ? "1" : "0"
      if (!button) return
      // In the list's own pixels, fractions kept, whatever scales it.
      const box = list.getBoundingClientRect()
      const scale = box.width / list.offsetWidth || 1
      const rect = button.getBoundingClientRect()
      if (!placed.current) knob.style.transition = "none"
      knob.style.width = `${rect.width / scale}px`
      knob.style.translate = `${(rect.left - box.left) / scale}px 0`
      if (!placed.current) {
        void knob.offsetWidth
        knob.style.transition = ""
        placed.current = true
      }
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(list)
    return () => observer.disconnect()
  }, [active])

  return (
    <div
      ref={listRef}
      className={cn(
        "relative flex items-center gap-0.5 rounded-md! bg-foreground/[0.07] p-0.5 shadow-[inset_0_1px_2px_rgb(0_0_0/0.16)] dark:bg-black/35 dark:shadow-[inset_0_1px_3px_rgb(0_0_0/0.45)]",
        className
      )}
    >
      <span
        ref={knobRef}
        aria-hidden="true"
        className="pointer-events-none absolute top-0.5 left-0 h-7 w-7 rounded-[5px] border border-transparent bg-background opacity-0 shadow-sm transition-[translate,width,opacity] duration-200 ease-out motion-reduce:transition-none dark:border-white/10 dark:bg-muted"
      />
      {items.map((item) => (
        <InsetSwitchButton key={item.id} item={item} labeled={labeled} />
      ))}
    </div>
  )
}

function InsetSwitchButton({
  item,
  labeled,
}: {
  item: InsetSwitchItem
  labeled: boolean
}) {
  const Icon = item.icon
  // A disabled button gets no pointer events: its tooltip needs the span.
  const button = (
    <span
      className="relative inline-flex"
      data-active={item.active || undefined}
      data-inset-switch-item=""
    >
      <Button
        aria-label={item.ready ? `${item.label}, ready` : item.label}
        aria-pressed={Boolean(item.active)}
        className={cn(
          "relative rounded-[5px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground dark:hover:bg-white/5",
          labeled
            ? "h-7 w-auto gap-1.5 px-2.5 text-[0.8rem] font-medium"
            : "size-7",
          item.active &&
            "text-foreground hover:bg-transparent dark:hover:bg-transparent"
        )}
        disabled={Boolean(item.unavailable)}
        size="icon"
        type="button"
        variant="ghost"
        onClick={item.onSelect}
      >
        <span className="relative inline-flex">
          <Icon />
          {item.ready ? (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-sky-500 shadow-[0_0_0_1.5px_var(--muted)]"
            />
          ) : null}
        </span>
        {labeled ? item.label : null}
      </Button>
    </span>
  )

  // A labeled button says what it shows: its tooltip only says why not.
  const tooltip =
    item.unavailable ??
    (labeled
      ? undefined
      : item.active
        ? item.label
        : (item.tooltip ?? item.label))
  if (!tooltip) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
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
