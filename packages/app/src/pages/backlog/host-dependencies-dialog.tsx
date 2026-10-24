import * as React from "react"
import {
  CircleAlertIcon,
  DownloadIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type {
  HostDependencyIssue,
  HostDependencyReport,
  RuntimeDiagnosticInput,
  RuntimeProgress,
} from "@/context/platform"
import { usePlatform } from "@/context/platform"
import { cn } from "@/lib/utils"
import {
  runtimeFailureDetail,
  runtimeFailureTitle,
  runtimeReportFailure,
} from "@/pages/backlog/runtime-failure"

const runtimeFailureToastId = "runtime-action-failure"

export type HostDependenciesDialogProps = {
  checking: boolean
  onOpenChange(open: boolean): void
  onRecheck(): Promise<void>
  open: boolean
  report?: HostDependencyReport
  storyTitle?: string
}

export function HostDependenciesDialog({
  checking,
  onOpenChange,
  onRecheck,
  open,
  report,
  storyTitle,
}: HostDependenciesDialogProps) {
  const platform = usePlatform()
  const issues = report?.issues ?? []
  const [runningAction, setRunningAction] = React.useState<string | null>(null)
  const [runtimeProgress, setRuntimeProgress] =
    React.useState<RuntimeProgress | null>(null)
  const busy = checking || Boolean(runningAction)

  async function runDependencyAction(issue: HostDependencyIssue) {
    const runtimeAction = dependencyRuntimeAction(issue, platform)
    if (runtimeAction) {
      setRunningAction(`${issue.name}-${issue.status}`)
      setRuntimeProgress(null)
      try {
        const result = await runtimeAction.run(setRuntimeProgress)
        const reportFailure = runtimeReportFailure(result)
        if (reportFailure) {
          showRuntimeFailureToast(
            reportFailure,
            runtimeAction.operation,
            platform
          )
          return
        }
        await onRecheck()
      } catch (error) {
        showRuntimeFailureToast(error, runtimeAction.operation, platform)
      } finally {
        setRunningAction(null)
        setRuntimeProgress(null)
      }
      return
    }
    const url = dependencyUrl(issue)
    if (!url) return
    if (platform.openExternalLink) platform.openExternalLink(url)
    else window.open(url, "_blank", "noopener,noreferrer")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Missing development requirements</DialogTitle>
          <DialogDescription>
            Blame needs these host tools before it can start development
            {storyTitle ? ` for ${storyTitle}` : ""}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {issues.map((issue) => (
            <DependencyIssueRow
              key={`${issue.name}-${issue.status}`}
              issue={issue}
              disabled={busy}
              loading={runningAction === `${issue.name}-${issue.status}`}
              progress={runtimeProgress}
              platform={platform}
              onAction={runDependencyAction}
            />
          ))}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void onRecheck()}
          >
            <RefreshCwIcon className={cn(checking && "animate-spin")} />
            {checking ? "Checking" : "Recheck"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DependencyIssueRow({
  disabled,
  issue,
  loading,
  onAction,
  platform,
  progress,
}: {
  disabled: boolean
  issue: HostDependencyIssue
  loading: boolean
  onAction(issue: HostDependencyIssue): Promise<void>
  platform: ReturnType<typeof usePlatform>
  progress: RuntimeProgress | null
}) {
  const actionAvailable = dependencyActionAvailable(issue, platform)

  return (
    <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <div className="font-medium">{dependencyLabel(issue)}</div>
        <div className="mt-1 text-sm text-muted-foreground">
          {issue.message} {issue.action}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={disabled || !actionAvailable}
        onClick={() => void onAction(issue)}
      >
        <DependencyButtonIcon
          issue={issue}
          loading={loading}
          platform={platform}
        />
        {loading
          ? runtimeProgressLabel(progress)
          : dependencyButtonLabel(issue, platform)}
      </Button>
    </div>
  )
}

function DependencyButtonIcon({
  issue,
  loading,
  platform,
}: {
  issue: HostDependencyIssue
  loading: boolean
  platform: ReturnType<typeof usePlatform>
}) {
  if (loading) return <LoaderCircleIcon className="animate-spin" />
  if (dependencyRuntimeAction(issue, platform)) return <RefreshCwIcon />
  if (!dependencyUrl(issue)) return <CircleAlertIcon />
  return <DownloadIcon />
}

function dependencyRuntimeAction(
  issue: HostDependencyIssue,
  platform: ReturnType<typeof usePlatform>
) {
  if (!managedRuntimePlatform(platform.platform)) return null
  if (resetRuntimeIssue(issue)) {
    return createRuntimeAction("reset", platform.workspace?.resetRuntime)
  }
  if (repairRuntimeIssue(issue)) {
    return createRuntimeAction("repair", platform.workspace?.repairRuntime)
  }
  if (issue.name === "blame-runtime") {
    return createRuntimeAction("ensure", platform.workspace?.ensureRuntimeReady)
  }
  return null
}

function repairRuntimeIssue(issue: HostDependencyIssue) {
  return (
    runtimeRepairDependency(issue.name) ||
    /\brepair\s+Blame\s*Runtime\b/i.test(issue.action)
  )
}

function createRuntimeAction(
  operation: RuntimeDiagnosticInput["operation"],
  run:
    | ((onProgress?: (progress: RuntimeProgress) => void) => Promise<unknown>)
    | undefined
) {
  return run ? { operation, run } : null
}

function runtimeProgressLabel(progress: RuntimeProgress | null) {
  if (!progress) return "Checking runtime"
  if (progress.phase === "downloading") {
    return progress.percent === undefined
      ? "Downloading runtime"
      : `Downloading runtime ${progress.percent}%`
  }
  if (progress.phase === "verifying") return "Verifying runtime"
  if (progress.phase === "installing") return "Installing runtime"
  if (progress.phase === "configuring") return "Configuring runtime"
  if (progress.phase === "starting") return "Starting runtime"
  return "Checking runtime"
}

function resetRuntimeIssue(issue: HostDependencyIssue) {
  return /\breset\b/i.test(issue.action)
}

function managedRuntimePlatform(platform?: string) {
  return platform === "darwin" || platform === "win32"
}

function containerRuntimeDependency(name: HostDependencyIssue["name"]) {
  return ["docker", "docker-compose"].includes(name)
}

function runtimeRepairDependency(name: HostDependencyIssue["name"]) {
  return name === "cline-sdk" || containerRuntimeDependency(name)
}

function dependencyButtonLabel(
  issue: HostDependencyIssue,
  platform: ReturnType<typeof usePlatform>
) {
  if (dependencyRuntimeAction(issue, platform)) {
    if (resetRuntimeIssue(issue)) return "Reset Runtime"
    return repairRuntimeIssue(issue) ? "Repair Runtime" : "Setup Runtime"
  }
  if (!dependencyUrl(issue)) return "Unavailable"
  if (issue.status === "unsupported") return "Upgrade"
  return "Download"
}

function dependencyLabel(issue: HostDependencyIssue) {
  const labels: Record<HostDependencyIssue["name"], string> = {
    "blame-runtime": "Blame Runtime",
    "cline-sdk": "Cline SDK",
    corepack: "Corepack",
    docker: "Docker Engine",
    "docker-compose": "Docker Compose",
    git: "Git",
    node: "Node.js 22+",
    npm: "npm",
    pnpm: "pnpm",
    yarn: "Yarn",
    bun: "Bun",
    pip: "pip",
  }
  return (
    labels[issue.name] ??
    (repairRuntimeIssue(issue) ? "Blame Runtime" : "Development requirement")
  )
}

function dependencyActionAvailable(
  issue: HostDependencyIssue,
  platform: ReturnType<typeof usePlatform>
) {
  return Boolean(
    dependencyRuntimeAction(issue, platform) || dependencyUrl(issue)
  )
}

function dependencyUrl(issue: HostDependencyIssue) {
  const urls: Record<HostDependencyIssue["name"], string> = {
    "blame-runtime": "https://blame.dev",
    "cline-sdk": "https://blame.dev",
    corepack: "https://nodejs.org/en/download",
    docker: "https://docs.docker.com/engine/install/",
    "docker-compose": "https://docs.docker.com/compose/install/linux/",
    git: "https://git-scm.com/downloads",
    node: "https://nodejs.org/en/download",
    npm: "https://nodejs.org/en/download",
    pnpm: "https://pnpm.io/installation",
    yarn: "https://yarnpkg.com/getting-started/install",
    bun: "https://bun.sh/docs/installation",
    pip: "https://packaging.python.org/en/latest/tutorials/installing-packages/",
  }
  return urls[issue.name]
}

function showRuntimeFailureToast(
  error: unknown,
  operation: RuntimeDiagnosticInput["operation"],
  platform: ReturnType<typeof usePlatform>
) {
  const detail = runtimeFailureDetail(error)
  const send = platform.telemetry?.sendRuntimeDiagnostic
  toast.error(runtimeFailureTitle(operation), {
    action: send
      ? {
          label: "Send diagnostic",
          onClick: () =>
            void submitRuntimeDiagnostic({ detail, operation }, platform),
        }
      : undefined,
    description: detail,
    duration: Infinity,
    id: runtimeFailureToastId,
  })
}

async function submitRuntimeDiagnostic(
  input: RuntimeDiagnosticInput,
  platform: ReturnType<typeof usePlatform>
) {
  try {
    const sent = await platform.telemetry?.sendRuntimeDiagnostic?.(input)
    if (!sent) {
      showDiagnosticSendFailure()
      return
    }
    toast.dismiss(runtimeFailureToastId)
    toast.success("Runtime diagnostic sent", {
      description: "The error details were sent to Blame for investigation.",
    })
  } catch {
    showDiagnosticSendFailure()
  }
}

function showDiagnosticSendFailure() {
  toast.error("Unable to send runtime diagnostic", {
    description: "Check your connection and sign-in status, then try again.",
  })
}
