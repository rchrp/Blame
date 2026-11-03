import * as React from "react"

import { TabsList } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

// Tabs whose selection is one knob that slides to the tab chosen, as the
// runner's view switch does. Their triggers take slidingTabsTrigger.
export function SlidingTabsList({
  children,
  className,
  value,
  ...props
}: React.ComponentProps<typeof TabsList> & { value: string }) {
  const listRef = React.useRef<HTMLDivElement>(null)
  const knobRef = React.useRef<HTMLSpanElement>(null)
  React.useLayoutEffect(() => {
    const list = listRef.current
    const knob = knobRef.current
    if (!list || !knob) return
    const place = () => {
      const active = list.querySelector<HTMLElement>(
        '[data-slot="tabs-trigger"][data-state="active"]'
      )
      knob.style.opacity = active ? "1" : "0"
      if (!active) return
      knob.style.width = `${active.offsetWidth}px`
      knob.style.translate = `${active.offsetLeft}px 0`
    }
    place()
    // Placed without sliding first, then slides from there.
    const frame = window.requestAnimationFrame(() => {
      knob.dataset.placed = ""
    })
    // A tab that comes or goes (Preview, once the story runs) resizes the
    // others while the list keeps its width: each tab is followed.
    const observer = new ResizeObserver(place)
    const follow = () => {
      observer.observe(list)
      list
        .querySelectorAll('[data-slot="tabs-trigger"]')
        .forEach((trigger) => observer.observe(trigger))
    }
    follow()
    const tabsChange = new MutationObserver(() => {
      follow()
      place()
    })
    tabsChange.observe(list, { childList: true })
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      tabsChange.disconnect()
    }
  }, [value])
  return (
    <TabsList ref={listRef} className={cn("relative", className)} {...props}>
      <span
        ref={knobRef}
        aria-hidden="true"
        className="pointer-events-none absolute top-[3px] bottom-[3px] left-0 rounded-md border border-transparent bg-background opacity-0 shadow-sm data-placed:transition-[translate,width] data-placed:duration-200 data-placed:ease-out motion-reduce:transition-none dark:border-input dark:bg-input/30"
      />
      {children}
    </TabsList>
  )
}

// The trigger leaves its look to the knob under it.
export const slidingTabsTrigger =
  "z-10 data-active:bg-transparent data-active:shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"

// A blue dot on a tab's icon: something to see there now.
export function TabReadyIcon({
  children,
  ready,
}: {
  children: React.ReactNode
  ready: boolean
}) {
  return (
    <span className="relative inline-flex">
      {children}
      {ready ? (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-sky-500 shadow-[0_0_0_1.5px_var(--muted)]"
        />
      ) : null}
    </span>
  )
}
