import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import type { PlanStory } from "./plan-mode-data"
import {
  PlannedStoryCard,
  PlannedStoryDetail,
  type PlannedStoryActions,
} from "./planned-story-card"

const cardStep = 248

// The stories of one reply, side by side under it. Choosing a card shows it
// in full below the row, where it can be read, edited and added.
export function PlanStoryCarousel({
  actionsFor,
  stories,
}: {
  actionsFor: (story: PlanStory) => PlannedStoryActions
  stories: PlanStory[]
}) {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const [selectedKey, setSelectedKey] = React.useState<string>()
  const [edges, setEdges] = React.useState({ end: false, start: true })
  const selected = stories.find((story) => story.key === selectedKey)

  const updateEdges = React.useCallback(() => {
    const track = trackRef.current
    if (!track) return
    const start = track.scrollLeft <= 4
    const end = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4
    setEdges((current) =>
      current.start === start && current.end === end ? current : { end, start }
    )
  }, [])

  React.useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    updateEdges()
    const observer = new ResizeObserver(updateEdges)
    observer.observe(track)
    return () => observer.disconnect()
  }, [stories.length, updateEdges])

  const step = (direction: 1 | -1) =>
    trackRef.current?.scrollBy({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      left: direction * cardStep,
    })

  return (
    <div className="grid min-w-0 gap-2">
      <section
        aria-label="Proposed user stories"
        aria-roledescription="carousel"
        className="group/carousel relative min-w-0"
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === "ArrowLeft") step(-1)
          if (event.key === "ArrowRight") step(1)
        }}
      >
        <div
          ref={trackRef}
          className="-mx-1 flex snap-x snap-mandatory scroll-px-1 [scrollbar-width:none] gap-2 overflow-x-auto overscroll-x-contain px-1 pt-1 pb-1.5 [&::-webkit-scrollbar]:hidden"
          onScroll={updateEdges}
        >
          {stories.map((story, index) => (
            <div
              key={story.key}
              aria-label={`${index + 1} of ${stories.length}: ${story.title}`}
              aria-roledescription="slide"
              className="w-60 shrink-0 snap-start motion-reduce:animate-none"
              role="group"
              style={{
                animation: `onboarding-rise 440ms cubic-bezier(0.16, 1, 0.3, 1) ${index * 40}ms both`,
              }}
            >
              <PlannedStoryCard
                actions={actionsFor(story)}
                onSelect={() =>
                  setSelectedKey((current) =>
                    current === story.key ? undefined : story.key
                  )
                }
                selected={story.key === selectedKey}
                story={story}
              />
            </div>
          ))}
        </div>
        <EdgeFade side="start" visible={!edges.start} />
        <EdgeFade side="end" visible={!edges.end} />
        <StepButton
          direction="previous"
          hidden={edges.start}
          onClick={() => step(-1)}
        />
        <StepButton
          direction="next"
          hidden={edges.end}
          onClick={() => step(1)}
        />
      </section>
      {selected ? (
        <PlannedStoryDetail
          key={selected.key}
          actions={actionsFor(selected)}
          onClose={() => setSelectedKey(undefined)}
          story={selected}
        />
      ) : null}
    </div>
  )
}

function EdgeFade({
  side,
  visible,
}: {
  side: "end" | "start"
  visible: boolean
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 w-10 from-popover to-transparent transition-opacity duration-200",
        side === "start"
          ? "-left-1 bg-gradient-to-r"
          : "-right-1 bg-gradient-to-l",
        visible ? "opacity-100" : "opacity-0"
      )}
    />
  )
}

function StepButton({
  direction,
  hidden,
  onClick,
}: {
  direction: "next" | "previous"
  hidden: boolean
  onClick: () => void
}) {
  const Icon = direction === "next" ? ChevronRightIcon : ChevronLeftIcon
  return (
    <Button
      aria-label={direction === "next" ? "Next stories" : "Previous stories"}
      className={cn(
        "absolute top-[calc(50%-0.875rem)] z-10 rounded-full border bg-background/90 shadow-sm backdrop-blur-sm transition-opacity motion-reduce:transition-none",
        direction === "next" ? "-right-3" : "-left-3",
        hidden
          ? "pointer-events-none opacity-0"
          : "opacity-0 group-focus-within/carousel:opacity-100 group-hover/carousel:opacity-100 [@media(hover:none)]:opacity-100"
      )}
      onClick={onClick}
      size="icon-sm"
      tabIndex={hidden ? -1 : 0}
      type="button"
      variant="outline"
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
