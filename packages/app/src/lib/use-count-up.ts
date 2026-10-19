import * as React from "react"

// Animates a number from what is on screen to the next value, for counters
// that change in front of the user (lines added, stories in a column).
// Mounting shows the value right away; reduced motion jumps straight to it.
export function useCountUp(value: number, durationMs = 600) {
  const [display, setDisplay] = React.useState(value)
  const displayRef = React.useRef(value)

  React.useEffect(() => {
    const from = displayRef.current
    if (from === value) return
    const show = (next: number) => {
      displayRef.current = next
      setDisplay(next)
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const frame = requestAnimationFrame(() => show(value))
      return () => cancelAnimationFrame(frame)
    }
    const start = performance.now()
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min((now - start) / durationMs, 1)
      const eased = 1 - (1 - progress) ** 3
      show(Math.round(from + (value - from) * eased))
      if (progress < 1) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [durationMs, value])

  return display
}
