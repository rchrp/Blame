import * as React from "react"
import { usePlatform } from "@/context/platform"

export function useManagedPreviewLog(sessionId?: string, service?: string) {
  const platform = usePlatform()
  const [state, setState] = React.useState({
    content: "",
    error: "",
    loading: Boolean(sessionId),
    service,
    sessionId,
  })

  React.useEffect(() => {
    if (!sessionId || !platform.previewRuntime?.onLog) return
    // A preview whose services never started sends no log at all.
    const quiet = window.setTimeout(
      () =>
        setState((current) =>
          current.sessionId === sessionId && current.service === service
            ? { ...current, loading: false }
            : { content: "", error: "", loading: false, service, sessionId }
        ),
      5_000
    )
    const unsubscribe = platform.previewRuntime.onLog(
      { sessionId },
      (event) => {
        // Setup output belongs to every service of the preview.
        if (
          service &&
          event.serviceId &&
          event.serviceId !== service &&
          event.serviceId !== "setup"
        )
          return
        const prefix = event.serviceId ? `${event.serviceId} | ` : ""
        setState((current) => {
          const content =
            current.sessionId === sessionId && current.service === service
              ? current.content
              : ""
          return {
            content: `${content}${prefix}${event.message}\n`.slice(-250_000),
            error: "",
            loading: false,
            service,
            sessionId,
          }
        })
      },
      (error) =>
        setState((current) => ({
          content:
            current.sessionId === sessionId && current.service === service
              ? current.content
              : "",
          error,
          loading: false,
          service,
          sessionId,
        }))
    )
    return () => {
      window.clearTimeout(quiet)
      unsubscribe?.()
    }
  }, [platform.previewRuntime, service, sessionId])

  return state.sessionId === sessionId && state.service === service
    ? state
    : { content: "", error: "", loading: Boolean(sessionId) }
}

export function useProjectServices(worktree?: string | null) {
  const platform = usePlatform()
  const [result, setResult] = React.useState<{
    services: string[]
    worktree: string
  }>({ services: [], worktree: "" })

  React.useEffect(() => {
    if (!worktree || !platform.workspace?.listProjectServices) return
    let cancelled = false
    const loadServices = () => {
      platform.workspace
        ?.listProjectServices?.({ worktree })
        .then((nextServices) => {
          if (!cancelled) setResult({ services: nextServices, worktree })
        })
        .catch(() => {
          if (!cancelled) setResult({ services: [], worktree })
        })
    }
    loadServices()
    const interval = window.setInterval(loadServices, 2000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [platform.workspace, worktree])

  return worktree && result.worktree === worktree ? result.services : []
}

export function useProjectServiceLog(
  worktree?: string | null,
  service?: string
) {
  const platform = usePlatform()
  const [state, setState] = React.useState({
    content: "",
    error: "",
    loading: Boolean(worktree && service),
    service,
    worktree,
  })

  React.useEffect(() => {
    if (!worktree || !service || !platform.workspace) return
    if (
      !platform.workspace.startProjectServiceLogs ||
      !platform.workspace.stopProjectServiceLogs ||
      !platform.workspace.onProjectServiceLog
    ) {
      return
    }
    let cancelled = false
    let cleanup = () => {}
    let activeStreamId = ""
    void platform.workspace
      .startProjectServiceLogs({ service, worktree })
      .then(({ streamId }) => {
        activeStreamId = streamId
        if (cancelled) {
          void platform.workspace?.stopProjectServiceLogs?.({ streamId })
          return
        }
        setState((current) => ({ ...current, loading: false }))
        cleanup =
          platform.workspace?.onProjectServiceLog?.(streamId, (event) => {
            if (event.type === "exit") return
            setState((current) => ({
              ...current,
              content: `${current.content}${event.data}`,
              error: "",
              loading: false,
            }))
          }) ?? (() => {})
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            content: "",
            error:
              error instanceof Error
                ? error.message
                : "Unable to read service logs",
            loading: false,
            service,
            worktree,
          })
        }
      })
    return () => {
      cancelled = true
      cleanup()
      if (activeStreamId) {
        void platform.workspace?.stopProjectServiceLogs?.({
          streamId: activeStreamId,
        })
      }
    }
  }, [platform.workspace, service, worktree])

  if (!worktree || !service) {
    return { content: "", error: "", loading: false, service, worktree }
  }
  if (
    !platform.workspace?.startProjectServiceLogs ||
    !platform.workspace.stopProjectServiceLogs ||
    !platform.workspace.onProjectServiceLog
  ) {
    return {
      content: "",
      error: "Desktop workspace bridge is unavailable.",
      loading: false,
      service,
      worktree,
    }
  }
  if (state.worktree !== worktree || state.service !== service) {
    return { content: "", error: "", loading: true, service, worktree }
  }
  return state
}
