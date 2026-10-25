import * as React from "react"
import { LoaderCircleIcon, ImageOffIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
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
export function AnnotationCanvas({
  source,
  name,
  marks,
  tool,
  color,
  width,
  selected,
  disabled,
  onChange,
  onSelect,
  onReady,
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
  onChange: (marks: Annotation[]) => void
  onSelect: (id: string | null) => void
  onReady: (ready: boolean, imageHeight?: number) => void
  onText: (point: Point, imageHeight: number, mark?: Annotation) => void
}) {
  const container = React.useRef<HTMLDivElement>(null)
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const gesture = React.useRef<Gesture | null>(null)
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  const [image, setImage] = React.useState<HTMLImageElement | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [retry, setRetry] = React.useState(0)
  const [preview, setPreview] = React.useState<Annotation[] | null>(null)
  const readyCallback = React.useEffectEvent(onReady)
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
  const scale = image
    ? Math.min(
        size.width / image.naturalWidth,
        size.height / image.naturalHeight,
        1
      )
    : 0
  const displayWidth = image ? image.naturalWidth * scale : 0
  const displayHeight = image ? image.naturalHeight * scale : 0
  const spaceHeight = image
    ? (1000 * image.naturalHeight) / image.naturalWidth
    : 1000
  React.useLayoutEffect(() => {
    const element = canvas.current
    const context = element?.getContext("2d")
    if (!element || !context || !displayWidth) return
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
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
      ref={container}
      className="flex size-full min-h-0 items-center justify-center"
    >
      {error ? (
        <div
          role="alert"
          className="flex max-w-md flex-col items-center gap-3 px-4 text-center"
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
          className="size-6 animate-spin text-muted-foreground"
        />
      ) : (
        <div
          className="relative shrink-0 overflow-hidden bg-background shadow-md"
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
            className="absolute inset-0 size-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            style={{
              cursor: disabled
                ? "default"
                : tool === "select"
                  ? "move"
                  : tool === "text"
                    ? "text"
                    : "crosshair",
            }}
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
