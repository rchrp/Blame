import * as React from "react"

/** The current time, refreshed every `intervalMs`, for labels that count time. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}
