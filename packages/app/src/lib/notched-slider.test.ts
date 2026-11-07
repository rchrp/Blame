import assert from "node:assert/strict"
import test from "node:test"

import {
  nearestMarkerIndex,
  notchPositions,
  sliderPoint,
  steppedNotchIndex,
} from "./notched-slider.ts"

test("spreads notches evenly from one end to the other", () => {
  assert.deepEqual(notchPositions(3), [0, 0.5, 1])
  assert.deepEqual(notchPositions(5), [0, 0.25, 0.5, 0.75, 1])
  assert.deepEqual(notchPositions(1), [0])
})

test("snaps a dragged position to the closest notch", () => {
  const markers = notchPositions(3)
  assert.equal(nearestMarkerIndex(markers, 0), 0)
  assert.equal(nearestMarkerIndex(markers, 0.24), 0)
  assert.equal(nearestMarkerIndex(markers, 0.26), 1)
  assert.equal(nearestMarkerIndex(markers, 0.74), 1)
  assert.equal(nearestMarkerIndex(markers, 0.76), 2)
  assert.equal(nearestMarkerIndex(markers, 1), 2)
})

test("keeps the earlier notch on a tie and finds none without notches", () => {
  assert.equal(nearestMarkerIndex([0, 0.5, 1], 0.25), 0)
  assert.equal(nearestMarkerIndex([], 0.4), undefined)
})

test("snaps to uneven markers, like the models of the smart selection", () => {
  assert.equal(nearestMarkerIndex([0, 0.1, 0.9, 1], 0.4), 1)
  assert.equal(nearestMarkerIndex([0, 0.1, 0.9, 1], 0.6), 2)
})

test("steps one notch per keypress or wheel turn and stops at the ends", () => {
  assert.equal(steppedNotchIndex(1, 1, 3), 2)
  assert.equal(steppedNotchIndex(1, -1, 3), 0)
  assert.equal(steppedNotchIndex(2, 1, 3), 2)
  assert.equal(steppedNotchIndex(0, -1, 3), 0)
})

test("keeps the thumb inside the track at both ends", () => {
  assert.equal(sliderPoint(0), "calc(0% + 16px)")
  assert.equal(sliderPoint(0.5), "calc(50% + 0px)")
  assert.equal(sliderPoint(1), "calc(100% + -16px)")
})
