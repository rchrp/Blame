export type Point = { x: number; y: number }
export type AnnotationTool =
  | "select"
  | "pen"
  | "arrow"
  | "rectangle"
  | "ellipse"
  | "text"
  | "eraser"
export type Annotation = {
  id: string
  kind: Exclude<AnnotationTool, "select" | "eraser">
  color: string
  width: number
  points: Point[]
  text?: string
}
export type AnnotationHistory = {
  past: Annotation[][]
  present: Annotation[]
  future: Annotation[][]
}

// All geometry uses a 1000-unit wide image space, independent of viewport and DPI.
export const annotationSpaceWidth = 1000
export function createHistory(present: Annotation[] = []): AnnotationHistory {
  return { past: [], present, future: [] }
}
export function commitAnnotations(
  history: AnnotationHistory,
  next: Annotation[]
): AnnotationHistory {
  if (JSON.stringify(history.present) === JSON.stringify(next)) return history
  return {
    past: [...history.past.slice(-99), history.present],
    present: next,
    future: [],
  }
}
export function undoAnnotations(history: AnnotationHistory): AnnotationHistory {
  const previous = history.past.at(-1)
  return previous
    ? {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      }
    : history
}
export function redoAnnotations(history: AnnotationHistory): AnnotationHistory {
  const next = history.future[0]
  return next
    ? {
        past: [...history.past, history.present],
        present: next,
        future: history.future.slice(1),
      }
    : history
}
export function imagePoint(
  client: Point,
  bounds: { left: number; top: number; width: number; height: number },
  height: number
): Point {
  return {
    x: Math.max(
      0,
      Math.min(1000, ((client.x - bounds.left) / bounds.width) * 1000)
    ),
    y: Math.max(
      0,
      Math.min(height, ((client.y - bounds.top) / bounds.height) * height)
    ),
  }
}
export function annotationBounds(mark: Annotation) {
  const xs = mark.points.map((p) => p.x)
  const ys = mark.points.map((p) => p.y)
  const x = Math.min(...xs),
    y = Math.min(...ys)
  if (mark.kind === "text") {
    const lines = (mark.text ?? "").split("\n")
    return {
      x,
      y,
      width:
        Math.max(...lines.map((line) => line.length), 1) *
        textSize(mark) *
        0.65,
      height: lines.length * textSize(mark) * 1.25,
    }
  }
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}
export function moveAnnotation(
  mark: Annotation,
  delta: Point,
  height: number
): Annotation {
  const bounds = annotationBounds(mark)
  const dx = Math.max(
    -bounds.x,
    Math.min(delta.x, Math.max(0, 1000 - bounds.width) - bounds.x)
  )
  const dy = Math.max(
    -bounds.y,
    Math.min(delta.y, Math.max(0, height - bounds.height) - bounds.y)
  )
  return {
    ...mark,
    points: mark.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
  }
}
export function textSize(mark: Annotation) {
  return 20 + mark.width * 2
}
export function arrowHead(mark: Annotation): Point[] {
  const start = mark.points[0],
    end = mark.points.at(-1)!
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const size = Math.min(
    Math.hypot(end.x - start.x, end.y - start.y) * 0.45,
    Math.max(14, mark.width * 4)
  )
  return [-0.5, 0.5].map((offset) => ({
    x: end.x - size * Math.cos(angle + offset),
    y: end.y - size * Math.sin(angle + offset),
  }))
}
function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)
    )
  )
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
export function hitAnnotation(
  mark: Annotation,
  point: Point,
  tolerance = 10
): boolean {
  const { x, y, width, height } = annotationBounds(mark)
  const padding = tolerance + mark.width / 2
  if (
    point.x < x - padding ||
    point.x > x + width + padding ||
    point.y < y - padding ||
    point.y > y + height + padding
  )
    return false
  if (mark.kind === "text") return true
  if (mark.kind === "ellipse") {
    const rx = width / 2,
      ry = height / 2
    if (!rx || !ry) return false
    const radius = Math.hypot((point.x - x - rx) / rx, (point.y - y - ry) / ry)
    return Math.abs(radius - 1) * Math.min(rx, ry) <= padding
  }
  let points = mark.points
  if (mark.kind === "rectangle")
    points = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
      { x, y },
    ]
  if (points.length === 1)
    return Math.hypot(point.x - points[0].x, point.y - points[0].y) <= padding
  if (
    mark.kind === "arrow" &&
    arrowHead(mark).some(
      (head) => segmentDistance(point, head, points.at(-1)!) <= padding
    )
  )
    return true
  return points
    .slice(1)
    .some((p, i) => segmentDistance(point, points[i], p) <= padding)
}
export function annotationAt(
  marks: Annotation[],
  point: Point,
  tolerance?: number
) {
  return marks.findLast((mark) => hitAnnotation(mark, point, tolerance))
}
export function annotatedFileName(name: string) {
  return `${name.replace(/\.[^.]+$/, "").replace(/-annotated$/, "") || "image"}-annotated.png`
}
