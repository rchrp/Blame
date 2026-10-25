import type { RuntimeProgress, RuntimeStatusReport } from "@/context/platform"

// What the Blame Runtime is doing, in the few words the interface uses.
export type RuntimePhase =
  // This platform cannot run local containers from the app (web build).
  | "unavailable"
  | "checking"
  | "ready"
  | "stopped"
  | "starting"
  // Not installed yet.
  | "missing"
  // Installed but out of date; updates as soon as no local story runs.
  | "update-pending"
  | "installing"
  | "updating"
  | "repairing"
  // Something is wrong and the automatic repair did not fix it.
  | "needs-repair"
  // This machine cannot run it (old Windows without WSL 2, for example).
  | "unsupported"

export type RuntimeOperation = "start" | "install" | "update" | "repair" | "reset"

export function runtimePhaseFromReport(report: RuntimeStatusReport): RuntimePhase {
  if (report.status === "ready") return "ready"
  if (report.status === "unsupported") return "unsupported"
  if (report.startRequired) return "stopped"
  if (report.updateRequired) return "update-pending"
  if (report.status === "missing") return "missing"
  return "needs-repair"
}

// Work the app starts on its own, without asking.
export function automaticRuntimeOperation(input: {
  autoRepairTried: boolean
  canInstall: boolean
  localRunsActive: number
  phase: RuntimePhase
}): RuntimeOperation | undefined {
  if (!input.canInstall) return undefined
  if (input.phase === "stopped") return "start"
  // Updating restarts the runtime: wait until no local story is using it.
  if (input.phase === "update-pending")
    return input.localRunsActive === 0 ? "update" : undefined
  if (input.phase === "needs-repair" && !input.autoRepairTried) return "repair"
  return undefined
}

// Phases during which a new local container story must wait.
export function runtimeBlocksNewRuns(phase: RuntimePhase) {
  return (
    phase === "checking" ||
    phase === "stopped" ||
    phase === "starting" ||
    phase === "update-pending" ||
    phase === "installing" ||
    phase === "updating" ||
    phase === "repairing"
  )
}

export function runtimeBusy(phase: RuntimePhase) {
  return phase === "starting" || phase === "installing" || phase === "updating" || phase === "repairing"
}

export function runtimeOperationPhase(operation: RuntimeOperation): RuntimePhase {
  if (operation === "start") return "starting"
  if (operation === "install") return "installing"
  if (operation === "update") return "updating"
  return "repairing"
}

export function runtimeOperationTitle(operation: RuntimeOperation) {
  if (operation === "start") return "Starting Blame Runtime"
  if (operation === "install") return "Installing Blame Runtime"
  if (operation === "update") return "Updating Blame Runtime"
  if (operation === "reset") return "Resetting Blame Runtime"
  return "Repairing Blame Runtime"
}

export function runtimeOperationDoneTitle(operation: RuntimeOperation) {
  if (operation === "start") return "Blame Runtime is ready"
  if (operation === "update") return "Blame Runtime is up to date"
  if (operation === "install") return "Blame Runtime is installed"
  return "Blame Runtime is working again"
}

export function runtimeOperationFailedTitle(operation: RuntimeOperation) {
  const verbs: Record<RuntimeOperation, string> = {
    start: "started",
    install: "installed",
    repair: "repaired",
    reset: "reset",
    update: "updated",
  }
  return `Blame Runtime couldn't be ${verbs[operation]}`
}

export function runtimeProgressText(progress: RuntimeProgress | undefined) {
  if (!progress) return "Getting ready…"
  const percent =
    progress.percent === undefined ? "" : ` ${Math.round(progress.percent)}%`
  if (progress.phase === "downloading") return `Downloading${percent}`
  if (progress.phase === "installing") return `Installing${percent}`
  if (progress.phase === "configuring") return "Setting things up…"
  if (progress.phase === "starting") return "Starting…"
  if (progress.phase === "verifying") return "Checking it works…"
  return "Getting ready…"
}

// One line for the status indicator and the settings page.
export function runtimePhaseLabel(phase: RuntimePhase) {
  const labels: Record<RuntimePhase, string> = {
    unavailable: "Not available here",
    checking: "Checking…",
    ready: "Ready",
    stopped: "Stopped",
    starting: "Starting…",
    missing: "Not installed",
    "update-pending": "Update waiting for running stories",
    installing: "Installing…",
    updating: "Updating…",
    repairing: "Repairing…",
    "needs-repair": "Needs a repair",
    unsupported: "Not supported on this computer",
  }
  return labels[phase]
}
