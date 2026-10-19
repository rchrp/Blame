import * as React from "react"
import { toast } from "sonner"

import { RuntimeProgressBody } from "@/components/runtime/runtime-progress"
import { usePlatform, type RuntimeProgress, type RuntimeStatusReport } from "@/context/platform"
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
// Everything else asks it instead of checking the runtime on its own.

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
        operation === "reset" ? workspace?.resetRuntime : workspace?.ensureRuntimeReady
      if (!action) return Promise.resolve(false)
      const title = runtimeOperationTitle(operation)
      const show = (next?: RuntimeProgress) =>
        toast.loading(title, {
          className: "runtime-progress-toast",
          description: <RuntimeProgressBody progress={next} />,
          duration: Infinity,
          id: toastId,
          position: "bottom-right",
        })
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
          toast.success(runtimeOperationDoneTitle(operation), {
            description:
              operation === "update"
                ? "Queued stories start again."
                : "Local container previews are ready to use.",
            duration: 5_000,
            id: toastId,
            position: "bottom-right",
          })
          return true
        } catch (error) {
          const detail = runtimeFailureDetail(error)
          setLastError(detail)
          setPhase("needs-repair")
          toast.error(runtimeOperationFailedTitle(operation), {
            action: { label: "Details", onClick: () => setPrompt({}) },
            description: detail.split("\n").at(-1),
            duration: 10_000,
            id: toastId,
            position: "bottom-right",
          })
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
    }),
    [canInstall, closePrompt, install, lastError, phase, progress, prompt, promptInstall, refresh, report, reset]
  )

  return (
    <BlameRuntimeContext.Provider value={value}>{children}</BlameRuntimeContext.Provider>
  )
}

export function useBlameRuntime() {
  const value = React.useContext(BlameRuntimeContext)
  if (!value) throw new Error("useBlameRuntime must be used inside BlameRuntimeProvider")
  return value
}

// Lets screens rendered outside the provider (tests, harnesses) opt out.
export function useOptionalBlameRuntime() {
  return React.useContext(BlameRuntimeContext)
}
