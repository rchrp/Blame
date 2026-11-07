import * as React from "react"
import { LoaderCircleIcon, ImageOffIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  annotationAt,
  annotationBounds,
  imagePoint,
  moveAnnotation,
  type Annotation,
  type AnnotationTool,
  type Point,
} from "./annotation-model"
import { drawAnnotations, loadAnnotationImage } from "./annotation-renderer"

type Gesture = {
  pointer: number
  start: Point
  before: Annotation[]
  mark?: Annotation
  moved?: boolean
}
type Zoom = number | "fit"
type ZoomPoint = { clientX: number; clientY: number }
type ZoomAnchor = ZoomPoint & { ratioX: number; ratioY: number }
type Pan = {
  left: number
  moved: boolean
  top: number
  x: number
  y: number
}
// What the viewer shows of the loaded image, for its zoom and size readouts.
export type ImageView = { height: number; scale: number; width: number }

const minimumZoom = 0.5
const maximumZoom = 4
// Keeps a zoomed overlay below what browsers allow for a canvas.
const maximumOverlayPixels = 4096

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}

// The image fits its container until zoomed. Zoomed, it can be dragged around
// while it is not being annotated; Ctrl or ⌘ with the wheel (a trackpad pinch)
// zooms around the pointer, a click toggles actual size, a double click fits.
export function AnnotationCanvas({
  source,
  name,
  marks,
  tool,
  color,
  width,
  selected,
  disabled,
  zoom,
  onChange,
  onSelect,
  onReady,
  onView,
  onZoom,
  onText,
}: {
  source: string
  name: string
  marks: Annotation[]
  tool: AnnotationTool
  color: string
  width: number
  selected: string | null
  disabled: boolean
  zoom: Zoom
  onChange: (marks: Annotation[]) => void
  onSelect: (id: string | null) => void
  onReady: (ready: boolean, imageHeight?: number) => void
  onView: (view: ImageView) => void
  onZoom: (zoom: Zoom) => void
  onText: (point: Point, imageHeight: number, mark?: Annotation) => void
}) {
  const container = React.useRef<HTMLDivElement>(null)
  const frame = React.useRef<HTMLDivElement>(null)
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const gesture = React.useRef<Gesture | null>(null)
  const pan = React.useRef<Pan | undefined>(undefined)
  const anchor = React.useRef<ZoomAnchor | undefined>(undefined)
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  const [image, setImage] = React.useState<HTMLImageElement | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [retry, setRetry] = React.useState(0)
  const [preview, setPreview] = React.useState<Annotation[] | null>(null)
  const readyCallback = React.useEffectEvent(onReady)
  const viewCallback = React.useEffectEvent(onView)
  React.useEffect(() => {
    let canceled = false
    readyCallback(false)
    loadAnnotationImage(source)
      .then((loaded) => {
        if (canceled) return
        setImage(loaded)
        setError(null)
        readyCallback(true, (1000 * loaded.naturalHeight) / loaded.naturalWidth)
      })
      .catch((reason: Error) => {
        if (!canceled) setError(reason.message)
      })
    return () => {
      canceled = true
    }
  }, [source, retry])
  React.useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      })
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const fitScale = image
    ? Math.min(
        size.width / image.naturalWidth,
        size.height / image.naturalHeight,
        1
      )
    : 0
  const zoomed = zoom !== "fit"
  const scale = zoomed ? zoom : fitScale
  const displayWidth = image ? image.naturalWidth * scale : 0
  const displayHeight = image ? image.naturalHeight * scale : 0
  const spaceHeight = image
    ? (1000 * image.naturalHeight) / image.naturalWidth
    : 1000
  React.useLayoutEffect(() => {
    const element = canvas.current
    const context = element?.getContext("2d")
    if (!element || !context || !displayWidth) return
    const ratio = Math.min(
      window.devicePixelRatio || 1,
      2,
      maximumOverlayPixels / displayWidth
    )
    element.width = Math.ceil(displayWidth * ratio)
    element.height = Math.ceil(displayHeight * ratio)
    context.scale(element.width / 1000, element.width / 1000)
    const visible = preview ?? marks
    drawAnnotations(context, visible)
    const active = visible.find((mark) => mark.id === selected)
    if (active) {
      const bounds = annotationBounds(active)
      const unit = 1000 / displayWidth
      context.strokeStyle = "#3b82f6"
      context.lineWidth = unit * 1.5
      context.setLineDash([4 * unit, 4 * unit])
      context.strokeRect(
        bounds.x - 5 * unit,
        bounds.y - 5 * unit,
        bounds.width + 10 * unit,
        bounds.height + 10 * unit
      )
    }
  }, [marks, preview, selected, displayWidth, displayHeight])
  React.useEffect(() => {
    if (image)
      viewCallback({
        height: image.naturalHeight,
        scale,
        width: image.naturalWidth,
      })
  }, [image, scale])
  function zoomTo(next: Zoom, point?: ZoomPoint) {
    const rect = frame.current?.getBoundingClientRect()
    if (point && rect?.width && rect.height)
      anchor.current = {
        clientX: point.clientX,
        clientY: point.clientY,
        ratioX: clamp((point.clientX - rect.left) / rect.width, 0, 1),
        ratioY: clamp((point.clientY - rect.top) / rect.height, 0, 1),
      }
    onZoom(next)
  }
  // Keeps the point that was under the pointer in place after a zoom; a zoom
  // without one (the toolbar) stays centered.
  React.useLayoutEffect(() => {
    const stage = container.current
    const element = frame.current
    const point = anchor.current
    anchor.current = undefined
    if (!stage || !element) return
    if (!point) {
      stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2
      stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2
      return
    }
    const rect = element.getBoundingClientRect()
    stage.scrollLeft += rect.left + point.ratioX * rect.width - point.clientX
    stage.scrollTop += rect.top + point.ratioY * rect.height - point.clientY
  }, [displayWidth])
  const wheelZoom = React.useEffectEvent((event: WheelEvent) => {
    const factor = Math.exp(-event.deltaY * 0.0015)
    zoomTo(
      clamp(scale * factor, Math.min(minimumZoom, fitScale), maximumZoom),
      event
    )
  })
  // Wheel zoom needs a non-passive listener to keep the page from zooming.
  React.useEffect(() => {
    const stage = container.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      wheelZoom(event)
    }
    stage.addEventListener("wheel", onWheel, { passive: false })
    return () => stage.removeEventListener("wheel", onWheel)
  }, [])
  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    const stage = container.current
    if (event.button !== 0 || !disabled || !stage) return
    pan.current = {
      left: stage.scrollLeft,
      moved: false,
      top: stage.scrollTop,
      x: event.clientX,
      y: event.clientY,
    }
  }
  function movePan(event: React.PointerEvent<HTMLDivElement>) {
    const start = pan.current
    const stage = container.current
    if (!start || !stage || !zoomed || event.buttons !== 1) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (!start.moved && Math.hypot(dx, dy) < 4) return
    if (!start.moved) stage.setPointerCapture(event.pointerId)
    start.moved = true
    stage.scrollLeft = start.left - dx
    stage.scrollTop = start.top - dy
  }
  function toggleZoom(event: React.MouseEvent<HTMLDivElement>) {
    if (
      !disabled ||
      event.target !== canvas.current ||
      pan.current?.moved ||
      event.detail !== 1
    )
      return
    zoomTo(zoomed ? "fit" : 1, event)
  }
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    return imagePoint(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      spaceHeight
    )
  }
  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled || !image || event.button !== 0 || gesture.current) return
    event.preventDefault()
    event.currentTarget.focus()
    const p = point(event)
    const hit = annotationAt(marks, p, (8 * 1000) / displayWidth)
    if (tool === "text") {
      onText(p, spaceHeight)
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === "select") {
      onSelect(hit?.id ?? null)
      gesture.current = {
        pointer: event.pointerId,
        start: p,
        before: marks,
        mark: hit,
      }
      return
    }
    onSelect(null)
    if (tool === "eraser") {
      gesture.current = { pointer: event.pointerId, start: p, before: marks }
      setPreview(marks.filter((mark) => mark.id !== hit?.id))
      return
    }
    const mark: Annotation = {
      id: crypto.randomUUID(),
      kind: tool,
      color,
      width,
      points: [p, p],
    }
    gesture.current = {
      pointer: event.pointerId,
      start: p,
      before: marks,
      mark,
    }
    setPreview([...marks, mark])
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    const p = point(event)
    current.moved = true
    if (tool === "eraser") {
      setPreview((visible) => {
        const next = visible ?? current.before
        const hit = annotationAt(next, p, (8 * 1000) / displayWidth)
        return next.filter((mark) => mark.id !== hit?.id)
      })
    } else if (current.mark && tool === "select") {
      const moved = moveAnnotation(
        current.mark,
        { x: p.x - current.start.x, y: p.y - current.start.y },
        spaceHeight
      )
      setPreview(
        current.before.map((mark) => (mark.id === moved.id ? moved : mark))
      )
    } else if (current.mark) {
      current.mark = {
        ...current.mark,
        points:
          tool === "pen" ? [...current.mark.points, p] : [current.start, p],
      }
      setPreview([...current.before, current.mark])
    }
  }
  function finish(
    event: React.PointerEvent<HTMLCanvasElement>,
    cancel = false
  ) {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (!cancel && preview) {
      // A click creates a pen dot, but not an invisible shape.
      if (
        tool === "pen" ||
        tool === "eraser" ||
        tool === "select" ||
        current.moved
      )
        onChange(preview)
    }
    setPreview(null)
  }
  return (
    <div
      data-gallery-backdrop
      ref={container}
      className={cn(
        "flex size-full min-h-0",
        zoomed ? "overflow-auto overscroll-contain" : "overflow-hidden"
      )}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={() => {
        window.setTimeout(() => (pan.current = undefined))
      }}
      onClick={toggleZoom}
      onDoubleClick={() => {
        if (disabled) zoomTo("fit")
      }}
    >
      {error ? (
        <div
          role="alert"
          className="m-auto flex max-w-md flex-col items-center gap-3 px-4 text-center"
        >
          <ImageOffIcon className="size-7 text-muted-foreground" />
          <p>{error}</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setError(null)
              setRetry((value) => value + 1)
            }}
          >
            Try again
          </Button>
        </div>
      ) : !image ? (
        <LoaderCircleIcon
          aria-label="Loading image"
          className="m-auto size-6 animate-spin text-muted-foreground"
        />
      ) : (
        <div
          ref={frame}
          className="relative m-auto shrink-0 overflow-hidden bg-background shadow-md"
          style={{ width: displayWidth, height: displayHeight }}
        >
          <img
            src={source}
            alt={name}
            draggable={false}
            className="pointer-events-none block size-full select-none"
          />
          <canvas
            ref={canvas}
            role="img"
            aria-label={`Annotation canvas for ${name}`}
            tabIndex={disabled ? -1 : 0}
            className={cn(
              "absolute inset-0 size-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              disabled
                ? zoomed
                  ? "cursor-grab active:cursor-grabbing"
                  : "cursor-zoom-in"
                : tool === "select"
                  ? "cursor-move"
                  : tool === "text"
                    ? "cursor-text"
                    : "cursor-crosshair"
            )}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={(event) => finish(event)}
            onPointerCancel={(event) => finish(event, true)}
            onLostPointerCapture={(event) => finish(event, true)}
            onDoubleClick={(event) => {
              if (disabled || tool !== "select") return
              const p = imagePoint(
                { x: event.clientX, y: event.clientY },
                event.currentTarget.getBoundingClientRect(),
                spaceHeight
              )
              const hit = annotationAt(marks, p)
              if (hit?.kind === "text") onText(hit.points[0], spaceHeight, hit)
            }}
            onKeyDown={(event) => {
              if (tool === "text" && event.key === "Enter" && !disabled) {
                event.preventDefault()
                onText({ x: 100, y: spaceHeight / 2 }, spaceHeight)
              }
            }}
          />
        </div>
      )}
    </div>
  )
}
