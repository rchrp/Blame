import assert from "node:assert/strict"
import test from "node:test"
import {
  annotationAt,
  annotationBounds,
  arrowHead,
  annotatedFileName,
  commitAnnotations,
  createHistory,
  hitAnnotation,
  imagePoint,
  moveAnnotation,
  redoAnnotations,
  undoAnnotations,
  type Annotation,
} from "./annotation-model.ts"

const line: Annotation = {
  id: "line",
  kind: "pen",
  color: "#ef4444",
  width: 4,
  points: [
    { x: 100, y: 100 },
    { x: 400, y: 400 },
  ],
}
test("pointer coordinates follow the image, including scaled and portrait views", () => {
  assert.deepEqual(
    imagePoint(
      { x: 350, y: 600 },
      { left: 100, top: 100, width: 500, height: 1000 },
      2000
    ),
    { x: 500, y: 1000 }
  )
  assert.deepEqual(
    imagePoint(
      { x: -10, y: 3000 },
      { left: 100, top: 100, width: 500, height: 1000 },
      2000
    ),
    { x: 0, y: 2000 }
  )
})
test("undo and redo are immutable and a new edit discards the redo branch", () => {
  const empty = createHistory()
  const first = commitAnnotations(empty, [line])
  const undone = undoAnnotations(first)
  assert.deepEqual(redoAnnotations(undone).present, [line])
  assert.deepEqual(empty.present, [])
  assert.equal(commitAnnotations(first, [line]), first)
  assert.equal(
    commitAnnotations(undone, [{ ...line, id: "other" }]).future.length,
    0
  )
  assert.equal(undoAnnotations(empty), empty)
})
test("eraser/select hit visible strokes and select the topmost annotation", () => {
  const box: Annotation = { ...line, id: "box", kind: "rectangle" }
  assert.equal(hitAnnotation(line, { x: 250, y: 250 }), true)
  assert.equal(hitAnnotation(line, { x: 100, y: 300 }), false)
  assert.equal(hitAnnotation(box, { x: 250, y: 250 }), false)
  assert.equal(hitAnnotation(box, { x: 100, y: 250 }), true)
  assert.equal(
    annotationAt([line, { ...line, id: "top" }], { x: 250, y: 250 })?.id,
    "top"
  )
  const ellipse: Annotation = { ...box, kind: "ellipse" }
  assert.equal(hitAnnotation(ellipse, { x: 250, y: 100 }), true)
  assert.equal(hitAnnotation(ellipse, { x: 250, y: 250 }), false)
})
test("moving an annotation keeps its geometry within image bounds", () => {
  const moved = moveAnnotation(line, { x: 1000, y: -1000 }, 600)
  assert.deepEqual(moved.points, [
    { x: 700, y: 0 },
    { x: 1000, y: 300 },
  ])
  assert.deepEqual(line.points[0], { x: 100, y: 100 })
})
test("export creates PNG filenames without stacking suffixes", () => {
  assert.equal(annotatedFileName("screen.jpeg"), "screen-annotated.png")
  assert.equal(
    annotatedFileName("screen-annotated.png"),
    "screen-annotated.png"
  )
})

test("thick arrowheads are selectable outside the shaft bounds", () => {
  const arrow: Annotation = {
    ...line,
    kind: "arrow",
    width: 10,
    points: [
      { x: 100, y: 100 },
      { x: 400, y: 100 },
    ],
  }
  const head = arrowHead(arrow)[0]
  assert.equal(hitAnnotation(arrow, head, 0), true)
  assert.ok(annotationBounds(arrow).height > 30)
})

test("measured text remains inside the image when moved", () => {
  const label: Annotation = {
    ...line,
    kind: "text",
    text: "Label",
    textWidth: 3,
    points: [{ x: 990, y: 590 }],
  }
  const moved = moveAnnotation(label, { x: 0, y: 0 }, 600)
  const bounds = annotationBounds(moved)
  assert.ok(bounds.x + bounds.width <= 1000)
  assert.ok(bounds.y + bounds.height <= 600)
})

test("undo history is bounded without discarding the current drawing", () => {
  let history = createHistory()
  for (let i = 0; i < 150; i++)
    history = commitAnnotations(history, [{ ...line, id: String(i) }])
  assert.equal(history.past.length, 100)
  assert.equal(history.present[0].id, "149")
})
