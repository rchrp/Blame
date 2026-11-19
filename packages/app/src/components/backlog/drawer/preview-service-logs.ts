import * as React from "react"
import { RunLog } from "@/components/backlog/board/run-log"
import { samePreviewWorktree } from "@/components/backlog/drawer/preview-runtime-poll"
import { usePlatform } from "@/context/platform"

type ServiceLogState = {
  error: string
  loading: boolean
  log?: RunLog
}

export function useManagedPreviewLog(sessionId?: string, service?: string) {
  const platform = usePlatform()
  const [state, setState] = React.useState<
    ServiceLogState & { service?: string; sessionId?: string }
  >({ error: "", loading: Boolean(sessionId), service, sessionId })

  React.useEffect(() => {
    const runLogs = platform.runLogs
    if (!sessionId || !platform.previewRuntime?.onLog || !runLogs) return
    const log = new RunLog(runLogs)
    const shown = { error: "", loading: false, log, service, sessionId }
    // A preview whose services never started sends no log at all.
    const quiet = window.setTimeout(
      () =>
        setState((current) =>
          current.log === log ? { ...current, loading: false } : shown
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
        log.push(`${prefix}${event.message}\n`)
        setState((current) =>
          current.log === log && !current.loading && !current.error
            ? current
            : shown
        )
      },
      (error) => setState({ ...shown, error })
    )
    return () => {
      window.clearTimeout(quiet)
      unsubscribe?.()
      log.close()
    }
  }, [platform.previewRuntime, platform.runLogs, service, sessionId])

  return state.sessionId === sessionId && state.service === service
    ? state
    : { error: "", loading: Boolean(sessionId) }
}

// The services of the preview's manifest, read again when the desktop
// changes the preview's setup or state.
export function useProjectServices(worktree?: string | null) {
  const platform = usePlatform()
  const [result, setResult] = React.useState<{
    services: string[]
    worktree: string
  }>({ services: [], worktree: "" })

  React.useEffect(() => {
    const workspace = platform.workspace
    if (!worktree || !workspace?.listProjectServices) return
    let cancelled = false
    const show = (services: string[]) =>
      setResult((current) =>
        current.worktree === worktree &&
        current.services.join("\n") === services.join("\n")
          ? current
          : { services, worktree }
      )
    const loadServices = () => {
      workspace
        .listProjectServices?.({ worktree })
        .then((nextServices) => {
          if (!cancelled) show(nextServices)
        })
        .catch(() => {
          if (!cancelled) show([])
        })
    }
    loadServices()
    const stopListening = workspace.onProjectPreviewRuntimeChanged?.(
      (change) => {
        if (samePreviewWorktree(change.worktree, worktree)) loadServices()
      }
    )
    return () => {
      cancelled = true
      stopListening?.()
    }
  }, [platform.workspace, worktree])

  return worktree && result.worktree === worktree ? result.services : []
}

export function useProjectServiceLog(
  worktree?: string | null,
  service?: string
) {
  const platform = usePlatform()
  const { runLogs, workspace } = platform
  const [state, setState] = React.useState<
    ServiceLogState & { service?: string; worktree?: string | null }
  >({ error: "", loading: Boolean(worktree && service), service, worktree })

  React.useEffect(() => {
    if (
      !worktree ||
      !service ||
      !runLogs ||
      !workspace?.startProjectServiceLogs ||
      !workspace.stopProjectServiceLogs ||
      !workspace.onProjectServiceLog
    )
      return
    let cancelled = false
    let cleanup = () => {}
    let activeStreamId = ""
    // Each stream has a log of its own: output of the previous tab never
    // lands in this one.
    const log = new RunLog(runLogs)
    void workspace
      .startProjectServiceLogs({ service, worktree })
      .then(({ streamId }) => {
        activeStreamId = streamId
        if (cancelled) {
          void workspace.stopProjectServiceLogs?.({ streamId })
          return
        }
        setState({ error: "", loading: false, log, service, worktree })
        cleanup =
          workspace.onProjectServiceLog?.(streamId, (event) => {
            if (event.type !== "exit") log.push(event.data)
          }) ?? (() => {})
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
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
      log.close()
      if (activeStreamId) {
        void workspace.stopProjectServiceLogs?.({ streamId: activeStreamId })
      }
    }
  }, [runLogs, service, workspace, worktree])

  if (!worktree || !service) return { error: "", loading: false }
  if (
    !runLogs ||
    !workspace?.startProjectServiceLogs ||
    !workspace.stopProjectServiceLogs ||
    !workspace.onProjectServiceLog
  ) {
    return { error: "Desktop workspace bridge is unavailable.", loading: false }
  }
  if (state.worktree !== worktree || state.service !== service) {
    return { error: "", loading: true }
  }
  return state
}
