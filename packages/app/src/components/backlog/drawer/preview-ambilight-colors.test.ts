import assert from "node:assert/strict"
import test from "node:test"

import {
  glowColor,
  glowOpacity,
  imageAmbilight,
  sameAmbilight,
} from "./preview-ambilight-colors.ts"

type Rgb = [number, number, number]

// A width × height page painted by paint(x, y), in 0..1 coordinates.
function page(
  width: number,
  height: number,
  paint: (x: number, y: number) => Rgb
) {
  const data: number[] = []
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const [red, green, blue] = paint(
        (column + 0.5) / width,
        (row + 0.5) / height
      )
      data.push(red, green, blue, 255)
    }
  }
  return data
}

const dark: Rgb = [12, 12, 16]
const blue: Rgb = [70, 80, 240]
const green: Rgb = [40, 200, 90]

const hue = (color: { red: number; green: number; blue: number }) =>
  color.blue > color.red && color.blue > color.green
    ? "blue"
    : color.green > color.red
      ? "green"
      : "red"

test("lights an edge with the color along it, not the page's middle", () => {
  // A dark page with a blue band along the top right, as a hero's glow.
  const glow = imageAmbilight(
    page(64, 40, (x, y) => (y < 0.12 && x > 0.6 ? blue : dark)),
    64,
    40
  )
  assert.ok(glow?.topRight)
  assert.equal(hue(glow.topRight.color), "blue")
  assert.ok(glowOpacity(glow.topRight) > 0.6)
})

test("leaves a dark edge far dimmer than a colored one", () => {
  const glow = imageAmbilight(
    page(64, 40, (x, y) => (y < 0.12 && x > 0.6 ? blue : dark)),
    64,
    40
  )
  assert.ok(glow?.topRight && glow.bottomLeft)
  assert.ok(glow.bottomLeft.strength < glow.topRight.strength / 4)
})

test("takes an edge's main color instead of a gray mix of its colors", () => {
  // The right edge is mostly green with some blue: green, not teal-gray.
  const glow = imageAmbilight(
    page(64, 40, (x, y) => (x > 0.8 ? (y < 0.6 ? green : blue) : dark)),
    64,
    40
  )
  assert.ok(glow?.right)
  assert.equal(hue(glow.right.color), "green")
  assert.ok(glow.right.color.green > 150)
})

test("has nothing to glow on a page without color", () => {
  assert.equal(
    imageAmbilight(
      page(32, 20, () => [245, 245, 245]),
      32,
      20
    ),
    null
  )
  assert.equal(
    imageAmbilight(
      page(32, 20, () => dark),
      32,
      20
    ),
    null
  )
})

test("glows brighter than a dim page color, keeping its hue", () => {
  const lit = glowColor({ red: 20, green: 30, blue: 110 })
  assert.ok(Math.max(lit.red, lit.green, lit.blue) >= 199)
  assert.equal(hue(lit), "blue")
})

test("tells a changed glow from the same one", () => {
  const first = imageAmbilight(
    page(32, 20, (x, y) => (y < 0.15 ? blue : dark)),
    32,
    20
  )
  const again = imageAmbilight(
    page(32, 20, (x, y) => (y < 0.15 ? blue : dark)),
    32,
    20
  )
  const other = imageAmbilight(
    page(32, 20, (x, y) => (y < 0.15 ? green : dark)),
    32,
    20
  )
  assert.ok(first && again && other)
  assert.equal(sameAmbilight(first, again), true)
  assert.equal(sameAmbilight(first, other), false)
})
