import * as React from "react"
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ScanIcon,
  XIcon,
  ZoomInIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { usePlatform } from "@/context/platform"
import { cn } from "@/lib/utils"

import {
  useAgentScreenshot,
  type ScreenshotItem,
} from "./agent-screenshot-context"
import { ScreenshotUnavailable } from "./screenshot-thumbnail"

const minimumScale = 0.5
const maximumScale = 4
type Anchor = {
  clientX: number
  clientY: number
  ratioX: number
  ratioY: number
}

// A screenshot at full size. It opens fitted to the window; a click, or the
// zoom button, shows it at 100%, where it can be dragged around. Ctrl or ⌘
// with the wheel zooms around the pointer; a double click fits it again.
export function ScreenshotLightbox({
  index,
  items,
  onIndexChange,
  onOpenChange,
  open,
  returnFocus,
}: {
  index: number
  items: ScreenshotItem[]
  onIndexChange: (index: number) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  // The control that opened the lightbox: it gets the focus back.
  returnFocus?: HTMLElement | null
}) {
  const current = items[Math.min(Math.max(index, 0), items.length - 1)]
  const count = items.length
  const go = React.useCallback(
    (step: number) => {
      if (count < 2) return
      onIndexChange(Math.min(Math.max(index + step, 0), count - 1))
    },
    [count, index, onIndexChange]
  )
  if (!current) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-black/80 p-0 text-popover-foreground ring-0 sm:max-w-none motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none"
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.isConnected) return
          event.preventDefault()
          returnFocus.focus()
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault()
            go(-1)
          } else if (event.key === "ArrowRight") {
            event.preventDefault()
            go(1)
          }
        }}
      >
        <DialogTitle className="sr-only">
          {count > 1 ? `Screenshot ${index + 1} of ${count}` : "Screenshot"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {current.caption ??
            current.ref?.pageUrl ??
            "A screenshot taken by the agent."}
        </DialogDescription>
        <LightboxImage
          key={current.id}
          item={current}
          index={index}
          count={count}
          onStep={go}
        />
      </DialogContent>
    </Dialog>
  )
}

function LightboxImage({
  count,
  index,
  item,
  onStep,
}: {
  count: number
  index: number
  item: ScreenshotItem
  onStep: (step: number) => void
}) {
  const state = useAgentScreenshot(item)
  const metadata = state.status === "ready" ? state.data.metadata : undefined
  const width = metadata?.width || item.ref?.width || 1440
  const height = metadata?.height || item.ref?.height || 900
  const viewportSize = useWindowSize()
  const fitScale = Math.min(
    1,
    (viewportSize.width * 0.9) / width,
    (viewportSize.height * 0.85) / height
  )
  const [scale, setScale] = React.useState<number | "fit">("fit")
  const effective = scale === "fit" ? fitScale : scale
  const stageRef = React.useRef<HTMLDivElement>(null)
  const imageRef = React.useRef<HTMLImageElement>(null)
  const anchor = React.useRef<Anchor | undefined>(undefined)
  const drag = React.useRef<
    | { left: number; moved: boolean; top: number; x: number; y: number }
    | undefined
  >(undefined)

  const zoomTo = React.useCallback(
    (next: number | "fit", point?: { clientX: number; clientY: number }) => {
      const image = imageRef.current
      if (point && image) {
        const rect = image.getBoundingClientRect()
        anchor.current = {
          clientX: point.clientX,
          clientY: point.clientY,
          ratioX: clamp((point.clientX - rect.left) / rect.width, 0, 1),
          ratioY: clamp((point.clientY - rect.top) / rect.height, 0, 1),
        }
      }
      setScale(next)
    },
    []
  )

  // Keeps the point that was under the pointer in place after a zoom.
  React.useLayoutEffect(() => {
    const point = anchor.current
    const stage = stageRef.current
    const image = imageRef.current
    anchor.current = undefined
    if (!point || !stage || !image) return
    const rect = image.getBoundingClientRect()
    stage.scrollLeft += rect.left + point.ratioX * rect.width - point.clientX
    stage.scrollTop += rect.top + point.ratioY * rect.height - point.clientY
  }, [effective])

  // Wheel zoom needs a non-passive listener to keep the page from zooming.
  React.useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * 0.0015)
      zoomTo(clamp(effective * factor, minimumScale, maximumScale), event)
    }
    stage.addEventListener("wheel", onWheel, { passive: false })
    return () => stage.removeEventListener("wheel", onWheel)
  }, [effective, zoomTo])

  const zoomed = scale !== "fit"
  const size = {
    height: Math.round(height * effective),
    width: Math.round(width * effective),
  }
  const pageUrl = item.ref?.pageUrl || metadata?.pageUrl
  const viewport = item.ref?.viewport ?? metadata?.viewport
  const colorScheme = item.ref?.colorScheme ?? metadata?.colorScheme

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3 text-xs">
        {count > 1 ? (
          <span
            aria-live="polite"
            className="rounded-md bg-popover px-2 py-1 text-popover-foreground tabular-nums"
          >
            {index + 1} / {count}
          </span>
        ) : null}
        <span className="flex-1" />
        <span className="rounded-md bg-popover px-2 py-1 text-popover-foreground tabular-nums">
          {Math.round(effective * 100)}%
        </span>
        <Button
          disabled={state.status !== "ready"}
          onClick={() => zoomTo(zoomed ? "fit" : 1)}
          size="sm"
          variant="secondary"
        >
          {zoomed ? <ScanIcon /> : <ZoomInIcon />}
          {zoomed ? "Fit to window" : "Actual size"}
        </Button>
        <DialogClose asChild>
          <Button aria-label="Close" size="icon-sm" variant="secondary">
            <XIcon />
          </Button>
        </DialogClose>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={stageRef}
          className={cn(
            "flex size-full",
            zoomed
              ? "cursor-grab overflow-auto overscroll-contain active:cursor-grabbing"
              : "overflow-hidden"
          )}
          onPointerDown={(event) => {
            if (event.button !== 0 || !stageRef.current) return
            drag.current = {
              left: stageRef.current.scrollLeft,
              moved: false,
              top: stageRef.current.scrollTop,
              x: event.clientX,
              y: event.clientY,
            }
          }}
          onPointerMove={(event) => {
            const start = drag.current
            const stage = stageRef.current
            if (!start || !stage || !zoomed || event.buttons !== 1) return
            const dx = event.clientX - start.x
            const dy = event.clientY - start.y
            if (!start.moved && Math.hypot(dx, dy) < 4) return
            if (!start.moved) stage.setPointerCapture(event.pointerId)
            start.moved = true
            stage.scrollLeft = start.left - dx
            stage.scrollTop = start.top - dy
          }}
          onPointerUp={() => {
            window.setTimeout(() => (drag.current = undefined))
          }}
        >
          <div
            className="m-auto shrink-0 p-4"
            style={{ boxSizing: "content-box", ...size }}
          >
            {state.status === "ready" ? (
              <img
                ref={imageRef}
                alt={
                  item.caption ??
                  (pageUrl ? `Screenshot of ${pageUrl}` : "Screenshot")
                }
                className={cn(
                  "block size-full rounded-md object-contain shadow-lg select-none",
                  zoomed ? "" : "cursor-zoom-in"
                )}
                draggable={false}
                src={state.data.dataUrl}
                onClick={(event) => {
                  if (drag.current?.moved || event.detail !== 1) return
                  zoomTo(zoomed ? "fit" : 1, event)
                }}
                onDoubleClick={() => zoomTo("fit")}
              />
            ) : state.status === "loading" ? (
              <Skeleton className="size-full rounded-md" />
            ) : (
              <ScreenshotUnavailable className="size-full bg-popover" />
            )}
          </div>
        </div>
        {count > 1 ? (
          <>
            <StepButton
              direction="previous"
              disabled={index === 0}
              onClick={() => onStep(-1)}
            />
            <StepButton
              direction="next"
              disabled={index === count - 1}
              onClick={() => onStep(1)}
            />
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-popover px-4 py-2.5 text-xs text-popover-foreground">
        <span
          className="min-w-0 flex-1 truncate"
          title={item.caption ?? pageUrl}
        >
          {item.caption ?? pageUrl ?? "Screenshot"}
        </span>
        {viewport ? (
          <span className="font-mono text-muted-foreground">
            {viewport.width}×{viewport.height}
          </span>
        ) : null}
        {colorScheme ? (
          <span className="text-muted-foreground">
            {colorScheme === "dark" ? "Dark" : "Light"}
          </span>
        ) : null}
        <ScreenshotActions id={item.id} disabled={state.status !== "ready"} />
      </div>
    </>
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
        "absolute top-1/2 -translate-y-1/2 shadow-md",
        direction === "next" ? "right-3" : "left-3"
      )}
      disabled={disabled}
      onClick={onClick}
      size="icon"
      variant="secondary"
    >
      <Icon />
    </Button>
  )
}

function ScreenshotActions({
  disabled,
  id,
}: {
  disabled: boolean
  id: string
}) {
  const screenshots = usePlatform().agentScreenshots
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])
  if (!screenshots) return null
  return (
    <span className="flex items-center gap-1.5">
      <Button
        disabled={disabled}
        onClick={() =>
          void screenshots.copy({ id }).then((done) => setCopied(done))
        }
        size="sm"
        variant="outline"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy image"}
      </Button>
      <Button
        disabled={disabled}
        onClick={() => void screenshots.saveAs({ id })}
        size="sm"
        variant="outline"
      >
        <DownloadIcon />
        Save as…
      </Button>
    </span>
  )
}

function useWindowSize() {
  const [size, setSize] = React.useState(() => ({
    height: typeof window === "undefined" ? 900 : window.innerHeight,
    width: typeof window === "undefined" ? 1440 : window.innerWidth,
  }))
  React.useEffect(() => {
    const update = () =>
      setSize({ height: window.innerHeight, width: window.innerWidth })
    window.addEventListener("resize", update)
    return () => window.removeEventListener("resize", update)
  }, [])
  return size
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}
