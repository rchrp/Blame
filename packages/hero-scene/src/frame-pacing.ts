// Decides when the scene needs a new frame.
//
// While something moves on screen (pointer parallax, camera travel, a
// celebration) the scene renders at up to 60 fps, even on 120 Hz displays where
// the extra frames are invisible for motion this slow. Once everything has
// settled, only the marker pulse and a very slow terrain sway remain, which read
// identically at 30 fps. Dropping to that rate halves GPU work while idle.

export const ACTIVE_FRAME_INTERVAL = 1000 / 60
export const IDLE_FRAME_INTERVAL = 1000 / 30
export const IDLE_AFTER_MS = 1400

// requestAnimationFrame timestamps jitter by a millisecond or two. Without
// this tolerance a 60 Hz display would skip every other frame.
const FRAME_TOLERANCE_MS = 2

export type FramePacer = {
  // Call when something starts moving (pointer, camera travel, celebration).
  markActive(now: number): void
  // Returns true when a frame should be rendered at this timestamp.
  shouldRender(now: number, settled: boolean): boolean
  // Resets after a pause so the first frame renders immediately.
  reset(): void
}

export function createFramePacer(): FramePacer {
  let lastRender = Number.NEGATIVE_INFINITY
  let lastActivity = Number.NEGATIVE_INFINITY

  return {
    markActive(now) {
      lastActivity = now
    },
    shouldRender(now, settled) {
      const idle = settled && now - lastActivity >= IDLE_AFTER_MS
      const interval = idle ? IDLE_FRAME_INTERVAL : ACTIVE_FRAME_INTERVAL

      if (now - lastRender < interval - FRAME_TOLERANCE_MS) {
        return false
      }

      lastRender = now
      return true
    },
    reset() {
      lastRender = Number.NEGATIVE_INFINITY
    },
  }
}
