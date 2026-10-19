import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACTIVE_FRAME_INTERVAL,
  IDLE_AFTER_MS,
  IDLE_FRAME_INTERVAL,
  createFramePacer,
} from './frame-pacing.ts'

function renderedFrames(
  pacer: ReturnType<typeof createFramePacer>,
  from: number,
  duration: number,
  refreshRate: number,
  settled: boolean,
) {
  let frames = 0
  const count = Math.round((duration * refreshRate) / 1000)
  for (let frame = 0; frame < count; frame += 1) {
    if (pacer.shouldRender(from + (frame * 1000) / refreshRate, settled)) frames += 1
  }
  return frames
}

test('renders every frame on a 60 Hz display while active', () => {
  const pacer = createFramePacer()
  pacer.markActive(0)
  assert.equal(renderedFrames(pacer, 0, 1000, 60, false), 60)
})

test('caps a 120 Hz display at 60 fps while active', () => {
  const pacer = createFramePacer()
  pacer.markActive(0)
  const frames = renderedFrames(pacer, 0, 1000, 120, false)
  assert.ok(frames >= 59 && frames <= 61, `rendered ${frames} frames`)
})

test('drops to 30 fps once settled and idle', () => {
  const pacer = createFramePacer()
  pacer.markActive(0)
  const frames = renderedFrames(pacer, IDLE_AFTER_MS, 1000, 60, true)
  assert.ok(frames >= 29 && frames <= 31, `rendered ${frames} frames`)
})

test('keeps the active rate while the scene is still moving', () => {
  const pacer = createFramePacer()
  pacer.markActive(0)
  assert.equal(renderedFrames(pacer, IDLE_AFTER_MS, 1000, 60, false), 60)
})

test('returns to the active rate on new activity', () => {
  const pacer = createFramePacer()
  pacer.markActive(0)
  renderedFrames(pacer, IDLE_AFTER_MS, 500, 60, true)
  pacer.markActive(IDLE_AFTER_MS + 500)
  assert.equal(renderedFrames(pacer, IDLE_AFTER_MS + 500, 1000, 60, true), 60)
})

test('renders immediately after a reset', () => {
  const pacer = createFramePacer()
  assert.equal(pacer.shouldRender(100, false), true)
  assert.equal(pacer.shouldRender(101, false), false)
  pacer.reset()
  assert.equal(pacer.shouldRender(102, false), true)
  assert.ok(IDLE_FRAME_INTERVAL > ACTIVE_FRAME_INTERVAL)
})
