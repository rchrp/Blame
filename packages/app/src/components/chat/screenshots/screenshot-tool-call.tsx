import * as React from "react"

import { cn } from "@/lib/utils"

import type { ScreenshotRef } from "../tool-calls/tool-call-view"
import {
  useAgentScreenshot,
  useScreenshotGroup,
  type ScreenshotItem,
} from "./agent-screenshot-context"
import { ScreenshotLightbox } from "./screenshot-lightbox"
import {
  PendingScreenshot,
  ScreenshotThumbnail,
  ScreenshotUnavailable,
} from "./screenshot-thumbnail"
import { Skeleton } from "@/components/ui/skeleton"

// Opens a screenshot in the lightbox, among every screenshot of its turn.
export function useLightbox(items: ScreenshotItem[]) {
  const group = useScreenshotGroup()
  const [state, setState] = React.useState<{
    index: number
    items: ScreenshotItem[]
    open: boolean
    returnFocus: HTMLElement | null
  }>()
  // Opens among the turn's screenshots, or among `from` when given.
  const open = (item: ScreenshotItem, from?: ScreenshotItem[]) => {
    const pool = from ?? items
    const inGroup = from ? -1 : group.findIndex((entry) => entry.id === item.id)
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    setState(
      inGroup >= 0
        ? { index: inGroup, items: group, open: true, returnFocus }
        : {
            index: Math.max(
              0,
              pool.findIndex((entry) => entry.id === item.id)
            ),
            items: pool,
            open: true,
            returnFocus,
          }
    )
  }
  const lightbox = state ? (
    <ScreenshotLightbox
      index={state.index}
      items={state.items}
      onIndexChange={(index) => setState({ ...state, index })}
      onOpenChange={(next) => setState({ ...state, open: next })}
      open={state.open}
      returnFocus={state.returnFocus}
    />
  ) : null
  return { lightbox, open }
}

// Under a collapsed screenshot tool call, without opening it.
export function ToolCallScreenshots({
  className,
  pending,
  screenshots,
}: {
  className?: string
  pending?: boolean
  screenshots: ScreenshotRef[]
}) {
  const items = screenshots.map((ref) => ({ id: ref.id, ref }))
  const { lightbox, open } = useLightbox(items)
  if (pending)
    return (
      <div className={className}>
        <PendingScreenshot />
      </div>
    )
  if (!items.length) return null
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {items.map((item) => (
        <ScreenshotThumbnail
          key={item.id}
          item={item}
          onOpen={() => open(item)}
        />
      ))}
      {lightbox}
    </div>
  )
}

// The opened tool call: the same capture, larger, and what it shows.
export function ScreenshotToolCallBody({
  pending,
  screenshots,
}: {
  pending?: boolean
  screenshots: ScreenshotRef[]
}) {
  const items = screenshots.map((ref) => ({ id: ref.id, ref }))
  const { lightbox, open } = useLightbox(items)
  if (pending) return <PendingScreenshot />
  return (
    <div className="grid gap-3">
      {items.map((item) => (
        <LargeScreenshot key={item.id} item={item} onOpen={() => open(item)} />
      ))}
      {lightbox}
    </div>
  )
}

function LargeScreenshot({
  item,
  onOpen,
}: {
  item: ScreenshotItem
  onOpen: () => void
}) {
  const state = useAgentScreenshot(item)
  const ref = item.ref
  const createdAt =
    state.status === "ready" ? state.data.metadata.createdAt : undefined
  const ratio =
    ref?.width && ref.height ? `${ref.width} / ${ref.height}` : "16 / 10"
  return (
    <figure className="grid min-w-0 gap-1.5">
      {state.status === "ready" ? (
        <button
          type="button"
          aria-label={`Open screenshot of ${ref?.pageUrl || "the preview"}`}
          className="cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted/40 shadow-xs transition-colors outline-none hover:border-foreground/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none"
          onClick={onOpen}
        >
          <img
            alt=""
            className="max-h-[360px] w-full object-contain"
            draggable={false}
            loading="lazy"
            src={state.data.dataUrl}
          />
        </button>
      ) : state.status === "loading" ? (
        <Skeleton
          className="max-h-[360px] w-full rounded-lg"
          style={{ aspectRatio: ratio }}
        />
      ) : (
        <ScreenshotUnavailable
          className="max-h-[360px] w-full"
          style={{ aspectRatio: ratio }}
        />
      )}
      <figcaption className="flex min-w-0 flex-wrap gap-x-3 text-xs text-muted-foreground">
        {ref?.pageUrl ? (
          <span className="min-w-0 truncate font-mono" title={ref.pageUrl}>
            {ref.pageUrl}
          </span>
        ) : null}
        {ref ? (
          <span className="font-mono">
            {ref.viewport.width}×{ref.viewport.height}
          </span>
        ) : null}
        {ref ? (
          <span>{ref.colorScheme === "dark" ? "Dark" : "Light"}</span>
        ) : null}
        {createdAt ? (
          <time dateTime={createdAt}>{timeLabel(createdAt)}</time>
        ) : null}
      </figcaption>
    </figure>
  )
}

function timeLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}
