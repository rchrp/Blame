import * as React from "react"
import { toast } from "sonner"

import { RuntimeProgressBody } from "@/components/runtime/runtime-progress"
import {
  usePlatform,
  type RuntimePowerEvent,
  type RuntimeProgress,
  type RuntimeStatusReport,
} from "@/context/platform"
import {
  automaticRuntimeOperation,
  runtimeOperationDoneTitle,
  runtimeOperationFailedTitle,
  runtimeOperationPhase,
  runtimeOperationTitle,
  runtimePhaseFromReport,
  type RuntimeOperation,
  type RuntimePhase,
} from "@/lib/blame-runtime-state"
import {
  runtimeFailureDetail,
  runtimeReportFailure,
} from "@/pages/backlog/runtime-failure"

// One place that knows the state of the Blame Runtime (the sandbox that runs
// local container previews) and drives installs, updates and repairs.
// Everything else asks it instead of checking the runtime on its own. The
// desktop starts the runtime when something needs it and stops it once
// unused: this follows those changes and shows a start the way it shows its
// own operations.

export type RuntimeInstallPrompt = {
  // Called when the person agrees to install or repair.
  onAccept?: () => void
  storyTitle?: string
}

type BlameRuntimeContextValue = {
  canInstall: boolean
  lastError?: string
  phase: RuntimePhase
  progress?: RuntimeProgress
  report?: RuntimeStatusReport
  // Installs (or repairs) in the background; progress shows bottom right.
  install(): Promise<boolean>
  // Starts a stopped runtime for a local story about to need it.
  start(): Promise<boolean>
  reset(): Promise<boolean>
  refresh(): Promise<RuntimePhase>
  // Opens the one dialog that explains the runtime and offers to install it.
  promptInstall(prompt?: RuntimeInstallPrompt): void
  // How many local container stories are running right now; updates wait
  // for this to reach zero.
  setLocalRunsActive(count: number): void
  prompt?: RuntimeInstallPrompt
  closePrompt(): void
}

const BlameRuntimeContext = React.createContext<BlameRuntimeContextValue | null>(null)
const toastId = "blame-runtime"

export function BlameRuntimeProvider({
  children,
  enabled = true,
}: {
  children: React.ReactNode
  // Off in secondary windows (the status window) so only the main window
  // checks and updates the runtime.
  enabled?: boolean
}) {
  const platform = usePlatform()
  const workspace = platform.workspace
  const available =
    enabled && Boolean(workspace?.runtimeStatus && workspace.ensureRuntimeReady)
  const canInstall =
    available && (platform.platform === "darwin" || platform.platform === "win32")
  const [phase, setPhase] = React.useState<RuntimePhase>(
    available ? "checking" : "unavailable"
  )
  const [report, setReport] = React.useState<RuntimeStatusReport>()
  const [progress, setProgress] = React.useState<RuntimeProgress>()
  const [lastError, setLastError] = React.useState<string>()
  const [prompt, setPrompt] = React.useState<RuntimeInstallPrompt>()
  const [localRunsActive, setLocalRunsActive] = React.useState(0)
  const autoRepairTried = React.useRef(false)
  const running = React.useRef<Promise<boolean> | undefined>(undefined)

  const phaseRef = React.useRef(phase)
  React.useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const refresh = React.useCallback(async (): Promise<RuntimePhase> => {
    if (!workspace?.runtimeStatus) return "unavailable"
    if (running.current) return phaseRef.current
    try {
      const next = await workspace.runtimeStatus()
      const nextPhase = runtimePhaseFromReport(next)
      setReport(next)
      setPhase(nextPhase)
      return nextPhase
    } catch (error) {
      setLastError(runtimeFailureDetail(error))
      setPhase("needs-repair")
      return "needs-repair"
    }
  }, [workspace])

  const run = React.useCallback(
    (operation: RuntimeOperation): Promise<boolean> => {
      if (running.current) return running.current
      const action =
        operation === "reset" ? workspace?.resetRuntime
          : operation === "repair" ? workspace?.repairRuntime ?? workspace?.ensureRuntimeReady
            : workspace?.ensureRuntimeReady
      if (!action) return Promise.resolve(false)
      const show = (next?: RuntimeProgress) => showRuntimeProgress(operation, next)
      setPhase(runtimeOperationPhase(operation))
      setProgress(undefined)
      setLastError(undefined)
      show()
      const task = (async () => {
        try {
          const result = await action((next) => {
            setProgress(next)
            show(next)
          })
          const failure = runtimeReportFailure(result)
          if (failure) throw new Error(failure)
          const next = await workspace?.runtimeStatus?.()
          if (next) setReport(next)
          setPhase(next ? runtimePhaseFromReport(next) : "ready")
          showRuntimeDone(operation)
          return true
        } catch (error) {
          const detail = runtimeFailureDetail(error)
          setLastError(detail)
          setPhase("needs-repair")
          showRuntimeFailure(operation, detail, () => setPrompt({}))
          return false
        } finally {
          setProgress(undefined)
          running.current = undefined
        }
      })()
      running.current = task
      return task
    },
    [workspace]
  )

  // Check once on start-up, then whenever the window comes back into focus
  // after a while (the runtime may have been stopped in the meantime).
  React.useEffect(() => {
    if (!available) return
    const firstCheck = window.setTimeout(() => void refresh(), 0)
    let lastCheck = Date.now()
    const handleFocus = () => {
      if (Date.now() - lastCheck < 10 * 60_000) return
      lastCheck = Date.now()
      void refresh()
    }
    window.addEventListener("focus", handleFocus)
    return () => {
      window.clearTimeout(firstCheck)
      window.removeEventListener("focus", handleFocus)
    }
  }, [available, refresh])

  // Starts and stops the desktop decided on: a start that something else
  // asked for shows like one of ours; ours show their own progress.
  const startShown = React.useRef(false)
  React.useEffect(() => {
    if (!available || !workspace?.onRuntimePowerChange) return
    return workspace.onRuntimePowerChange((event: RuntimePowerEvent) => {
      if (running.current) return
      if (event.state === "starting") {
        startShown.current = true
        setPhase("starting")
        setProgress(event.progress)
        showRuntimeProgress("start", event.progress)
        return
      }
      const shown = startShown.current
      startShown.current = false
      setProgress(undefined)
      if (event.state === "running") {
        void refresh().then(() => {
          if (shown) showRuntimeDone("start")
        })
        return
      }
      if (!event.error) {
        setPhase("stopped")
        if (shown) toast.dismiss(toastId)
        return
      }
      const detail = event.error
      void refresh().then(() => {
        setLastError(detail)
        showRuntimeFailure("start", detail, () => setPrompt({}))
      })
    })
  }, [available, refresh, workspace])

  // Updates and a first repair happen on their own.
  React.useEffect(() => {
    const operation = automaticRuntimeOperation({
      autoRepairTried: autoRepairTried.current,
      canInstall,
      localRunsActive,
      phase,
    })
    if (!operation) return
    if (operation === "repair") autoRepairTried.current = true
    void run(operation)
  }, [canInstall, localRunsActive, phase, run])

  const install = React.useCallback(() => {
    autoRepairTried.current = true
    return run(phaseRef.current === "missing" ? "install" : "repair")
  }, [run])
  const reset = React.useCallback(() => run("reset"), [run])
  const start = React.useCallback(() => {
    if (phaseRef.current === "ready") return Promise.resolve(true)
    if (phaseRef.current !== "stopped") return running.current ?? Promise.resolve(false)
    return run("start")
  }, [run])
  const promptInstall = React.useCallback(
    (next: RuntimeInstallPrompt = {}) => setPrompt(next),
    []
  )
  const closePrompt = React.useCallback(() => setPrompt(undefined), [])

  const value = React.useMemo<BlameRuntimeContextValue>(
    () => ({
      canInstall,
      closePrompt,
      install,
      lastError,
      phase,
      progress,
      prompt,
      promptInstall,
      refresh,
      report,
      reset,
      setLocalRunsActive,
      start,
    }),
    [canInstall, closePrompt, install, lastError, phase, progress, prompt, promptInstall, refresh, report, reset, start]
  )

  return (
    <BlameRuntimeContext.Provider value={value}>{children}</BlameRuntimeContext.Provider>
  )
}

function showRuntimeProgress(operation: RuntimeOperation, progress?: RuntimeProgress) {
  toast.loading(runtimeOperationTitle(operation), {
    className: "progress-notification-toast",
    description: <RuntimeProgressBody progress={progress} />,
    duration: Infinity,
    id: toastId,
    position: "bottom-right",
  })
}

function showRuntimeDone(operation: RuntimeOperation) {
  toast.success(runtimeOperationDoneTitle(operation), {
    description:
      operation === "update"
        ? "Queued stories start again."
        : "Local container previews are ready to use.",
    duration: 5_000,
    id: toastId,
    position: "bottom-right",
  })
}

function showRuntimeFailure(operation: RuntimeOperation, detail: string, details: () => void) {
  toast.error(runtimeOperationFailedTitle(operation), {
    action: { label: "Details", onClick: details },
    description: detail.split("\n").at(-1),
    duration: 10_000,
    id: toastId,
    position: "bottom-right",
  })
}

export function useBlameRuntime() {
  const value = React.useContext(BlameRuntimeContext)
  if (!value) throw new Error("useBlameRuntime must be used inside BlameRuntimeProvider")
  return value
}

// Starts a stopped runtime once when a screen shows the user is about to
// need it (writing a Local Container story), not again after an idle stop.
export function useRuntimeWarmup(intended: boolean) {
  const runtime = React.useContext(BlameRuntimeContext)
  const start = React.useEffectEvent(() => void runtime?.start())
  React.useEffect(() => {
    if (intended) start()
  }, [intended])
}

// Lets screens rendered outside the provider (tests, harnesses) opt out.
export function useOptionalBlameRuntime() {
  return React.useContext(BlameRuntimeContext)
}
