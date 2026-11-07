export type NotchDirection = -1 | 1

// Where the thumb sits for a position from 0 to 1: the thumb is 24px wide, so
// the ends stay inside the track.
export function sliderPoint(position: number) {
  const percent = position * 100
  const offset = 16 * (1 - 2 * position)
  return `calc(${percent}% + ${offset}px)`
}

// The positions of evenly spaced notches, from 0 to 1.
export function notchPositions(count: number) {
  if (count < 2) return [0]
  return Array.from({ length: count }, (_, index) => index / (count - 1))
}

// The index of the marker closest to a position; the earlier one on a tie.
export function nearestMarkerIndex(
  markers: readonly number[],
  position: number
) {
  let nearest = -1
  markers.forEach((marker, index) => {
    if (
      nearest < 0 ||
      Math.abs(marker - position) < Math.abs(markers[nearest]! - position)
    )
      nearest = index
  })
  return nearest < 0 ? undefined : nearest
}

// One notch further in a direction, never past either end.
export function steppedNotchIndex(
  index: number,
  direction: NotchDirection,
  count: number
) {
  return Math.min(count - 1, Math.max(0, index + direction))
}
