import * as React from "react"

// Animates a number from its previous value to the next one, for counters
// that change in front of the user (lines added, tests passed). Respects the
// reduced-motion setting by jumping straight to the value.
export function useCountUp(value: number, durationMs = 600) {
  const [display, setDisplay] = React.useState(value)
  const fromRef = React.useRef(value)

  React.useEffect(() => {
    const from = fromRef.current
    fromRef.current = value
    if (from === value) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const frame = requestAnimationFrame(() => setDisplay(value))
      return () => cancelAnimationFrame(frame)
    }
    const start = performance.now()
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min((now - start) / durationMs, 1)
      const eased = 1 - (1 - progress) ** 3
      setDisplay(Math.round(from + (value - from) * eased))
      if (progress < 1) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [durationMs, value])

  return display
}
