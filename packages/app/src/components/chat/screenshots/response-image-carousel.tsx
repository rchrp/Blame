import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

import {
  useAgentScreenshot,
  useScreenshotGroup,
  type ScreenshotItem,
} from "./agent-screenshot-context"
import { useLightbox } from "./screenshot-tool-call"
import { ScreenshotUnavailable } from "./screenshot-thumbnail"

// The screenshots the agent chose for its final reply, above the text.
// One image shows on its own; several become a carousel that scrolls with
// the trackpad or a swipe, the arrows, the keyboard or the thumbnails.
export function ResponseImageCarousel({
  images,
}: {
  images: Array<{ caption: string; id: string }>
}) {
  const group = useScreenshotGroup()
  const items = React.useMemo(
    () =>
      images.map((image) => ({
        ...image,
        ref: group.find((entry) => entry.id === image.id)?.ref,
      })),
    [group, images]
  )
  const { lightbox, open } = useLightbox(items)
  if (!items.length) return null
  if (items.length === 1)
    return (
      <figure className="grid min-w-0 gap-1.5">
        <Slide item={items[0]} onOpen={() => open(items[0], items)} />
        <figcaption className="text-xs text-muted-foreground">
          {items[0].caption}
        </figcaption>
        {lightbox}
      </figure>
    )
  return (
    <Carousel items={items} onOpen={(item) => open(item, items)}>
      {lightbox}
    </Carousel>
  )
}

function Carousel({
  children,
  items,
  onOpen,
}: {
  children: React.ReactNode
  items: ScreenshotItem[]
  onOpen: (item: ScreenshotItem) => void
}) {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const [current, setCurrent] = React.useState(0)
  const count = items.length
  const show = (index: number) => {
    const track = trackRef.current
    const next = Math.min(Math.max(index, 0), count - 1)
    if (!track) return
    track.scrollTo({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      left: next * track.clientWidth,
    })
    setCurrent(next)
  }
  return (
    <section
      aria-label="Screenshots from the agent"
      aria-roledescription="carousel"
      className="group/carousel grid min-w-0 gap-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault()
          show(current - 1)
        } else if (event.key === "ArrowRight") {
          event.preventDefault()
          show(current + 1)
        }
      }}
      role="region"
      tabIndex={0}
    >
      <div className="relative min-w-0">
        <div
          ref={trackRef}
          className="flex snap-x snap-mandatory [scrollbar-width:none] overflow-x-auto overscroll-x-contain [&::-webkit-scrollbar]:hidden"
          onScroll={(event) => {
            const track = event.currentTarget
            if (!track.clientWidth) return
            setCurrent(
              Math.min(
                count - 1,
                Math.round(track.scrollLeft / track.clientWidth)
              )
            )
          }}
        >
          {items.map((item, index) => (
            <div
              key={item.id}
              aria-label={`${index + 1} of ${count}: ${item.caption}`}
              aria-roledescription="slide"
              className="w-full min-w-0 shrink-0 snap-start"
              role="group"
            >
              <Slide
                item={item}
                onOpen={() => onOpen(item)}
                tabIndex={index === current ? 0 : -1}
              />
            </div>
          ))}
        </div>
        <StepButton
          direction="previous"
          disabled={current === 0}
          onClick={() => show(current - 1)}
        />
        <StepButton
          direction="next"
          disabled={current === count - 1}
          onClick={() => show(current + 1)}
        />
      </div>
      <div className="flex min-w-0 items-baseline gap-3 text-xs">
        <p aria-live="polite" className="min-w-0 flex-1 text-muted-foreground">
          {items[current]?.caption}
        </p>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {current + 1} / {count}
        </span>
      </div>
      <div
        className="flex min-w-0 gap-1.5 overflow-x-auto pb-0.5"
        data-slide-thumbnails
      >
        {items.map((item, index) => (
          <SlideThumbnail
            key={item.id}
            active={index === current}
            item={item}
            label={`Show screenshot ${index + 1} of ${count}: ${item.caption}`}
            onClick={() => show(index)}
          />
        ))}
      </div>
      {children}
    </section>
  )
}

function Slide({
  item,
  onOpen,
  tabIndex,
}: {
  item: ScreenshotItem
  onOpen: () => void
  tabIndex?: number
}) {
  const state = useAgentScreenshot(item)
  // A fixed 16:10 frame keeps the layout still while the image loads.
  const frame =
    "aspect-[16/10] w-full overflow-hidden rounded-lg border border-border bg-muted"
  if (state.status === "loading")
    return <Skeleton className={cn(frame, "border-0")} />
  if (state.status === "unavailable")
    return <ScreenshotUnavailable className="aspect-[16/10] w-full" />
  return (
    <button
      type="button"
      aria-label={`Open screenshot: ${item.caption ?? "screenshot"}`}
      className={cn(
        frame,
        "block cursor-zoom-in transition-colors outline-none hover:border-foreground/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none"
      )}
      onClick={onOpen}
      tabIndex={tabIndex}
    >
      <img
        alt={item.caption ?? ""}
        className="size-full object-contain"
        draggable={false}
        loading="lazy"
        src={state.data.dataUrl}
      />
    </button>
  )
}

function SlideThumbnail({
  active,
  item,
  label,
  onClick,
}: {
  active: boolean
  item: ScreenshotItem
  label: string
  onClick: () => void
}) {
  const state = useAgentScreenshot(item)
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      aria-label={label}
      className={cn(
        "h-12 w-[4.8rem] shrink-0 overflow-hidden rounded-md border border-border bg-muted transition-[box-shadow,opacity] outline-none focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none",
        active ? "ring-2 ring-ring" : "opacity-70 hover:opacity-100"
      )}
      onClick={onClick}
    >
      {state.status === "ready" ? (
        <img
          alt=""
          className="size-full object-cover object-top"
          draggable={false}
          src={state.data.dataUrl}
        />
      ) : null}
    </button>
  )
}

function StepButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "next" | "previous"
  disabled: boolean
  onClick: () => void
}) {
  const Icon = direction === "next" ? ChevronRightIcon : ChevronLeftIcon
  return (
    <Button
      aria-label={
        direction === "next" ? "Next screenshot" : "Previous screenshot"
      }
      className={cn(
        "absolute top-1/2 -translate-y-1/2 bg-background/85 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-focus-within/carousel:opacity-100 group-hover/carousel:opacity-100 focus-visible:opacity-100 disabled:!opacity-0 group-focus-within/carousel:disabled:!opacity-40 group-hover/carousel:disabled:!opacity-40 motion-reduce:transition-none [@media(hover:none)]:opacity-100 [@media(hover:none)]:disabled:!opacity-40",
        direction === "next" ? "right-2" : "left-2"
      )}
      disabled={disabled}
      onClick={onClick}
      size="icon-sm"
      variant="ghost"
    >
      <Icon />
    </Button>
  )
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}
