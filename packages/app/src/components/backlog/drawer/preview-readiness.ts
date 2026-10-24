import * as React from "react"

const warmupDelaysMs = [1_000, 2_000, 5_000, 15_000, 30_000]
const warmupTimeoutMs = 180_000

export function usePreviewWarmupReady(
  source: string | undefined,
  enabled: boolean,
  trigger: number | string | undefined
) {
  const key = `${enabled}:${source ?? ""}:${String(trigger)}`
  const [result, setResult] = React.useState({ key, ready: false })

  React.useEffect(() => {
    if (!enabled || !source) return
    let cancelled = false
    let timeout: number | undefined
    let attempt = 0
    const deadline = Date.now() + warmupTimeoutMs
    const check = async () => {
      const responds = await previewResponds(source)
      if (cancelled) return
      if (responds) {
        setResult({ key, ready: true })
        return
      }
      if (Date.now() >= deadline) return
      timeout = window.setTimeout(
        check,
        warmupDelaysMs[Math.min(attempt, warmupDelaysMs.length - 1)]
      )
      attempt += 1
    }
    void check()
    return () => {
      cancelled = true
      if (timeout) window.clearTimeout(timeout)
    }
  }, [enabled, key, source])

  return result.key === key && result.ready
}

export function useSetupPreviewReady(
  source: string | undefined,
  reloadKey: number,
  enabled: boolean
) {
  const [state, setState] = React.useState({
    ready: true,
    reloadKey: 0,
    source: "",
  })

  React.useEffect(() => {
    if (!enabled || !source) return
    let cancelled = false
    const check = async () => {
      const ready = await previewResponds(source)
      if (!cancelled) setState({ ready, reloadKey, source })
    }
    void check()
    const interval = window.setInterval(() => void check(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [enabled, reloadKey, source])

  if (!enabled || !source) return true
  if (state.source !== source || state.reloadKey !== reloadKey) return false
  return state.ready
}

// An app the project's runner just started: its page loads once its server
// answers, so the preview shows a loading state instead of a connection
// error while it starts. Each new run (runKey) waits again; once the server
// answered, later hiccups are the page's own business.
export function useStartedAppAnswered(
  source: string | undefined,
  runKey: string | undefined,
  enabled: boolean
) {
  const key = enabled && source ? `${source}\n${runKey ?? ""}` : ""
  const [answeredKey, setAnsweredKey] = React.useState("")

  React.useEffect(() => {
    if (!key || !source) return
    let cancelled = false
    let timeout: number | undefined
    const check = async () => {
      // A dev server compiling its first page can take a while to answer.
      const responds = await previewResponds(source, 10_000)
      if (cancelled) return
      if (responds) setAnsweredKey(key)
      else timeout = window.setTimeout(check, 1_000)
    }
    void check()
    return () => {
      cancelled = true
      if (timeout) window.clearTimeout(timeout)
    }
  }, [key, source])

  return !key || answeredKey === key
}

async function previewResponds(source: string, timeoutMs = 2500) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    await fetch(source, {
      cache: "no-store",
      mode: "no-cors",
      signal: controller.signal,
    })
    return true
  } catch {
    return false
  } finally {
    window.clearTimeout(timeout)
  }
}
