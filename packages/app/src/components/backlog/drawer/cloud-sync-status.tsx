import type { LiveSyncStatus } from "@blame/preview-runtime"
import {
  CheckIcon,
  ClockIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react"
import * as React from "react"

import { usePlatform } from "@/context/platform"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// Shows what the desktop does to keep a cloud preview in step with the local
// worktree, so a stalled or failing sync is visible instead of silent.

const pollMilliseconds = 1000

export function useLiveSyncStatus(sessionId: string | undefined) {
  const previewRuntime = usePlatform().previewRuntime
  const [entry, setEntry] = React.useState<{
    sessionId: string
    status?: LiveSyncStatus
  }>()
  React.useEffect(() => {
    if (!sessionId || !previewRuntime?.syncStatus) return
    let active = true
    const refresh = () =>
      void previewRuntime.syncStatus!({ sessionId })
        .then((next) => {
          if (active) setEntry({ sessionId, status: next ?? undefined })
        })
        .catch(() => undefined)
    refresh()
    const timer = window.setInterval(refresh, pollMilliseconds)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [previewRuntime, sessionId])
  return entry && entry.sessionId === sessionId ? entry.status : undefined
}

export function CloudSyncBadge({ status }: { status?: LiveSyncStatus }) {
  if (!status || status.state === "idle") return null
  const { icon, label, detail } = cloudSyncPresentation(status)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`Cloud sync: ${detail}`}
          className="mr-1 inline-flex shrink-0 cursor-help items-center gap-1 rounded-full border bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground data-[state=error]:border-destructive/40 data-[state=error]:text-destructive"
          data-state={status.state}
          tabIndex={0}
        >
          {icon}
          <span>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 text-pretty" sideOffset={6}>
        {detail}
      </TooltipContent>
    </Tooltip>
  )
}

export function cloudSyncPresentation(
  status: LiveSyncStatus,
  now = Date.now()
) {
  const files = fileCount(status.changedFiles)
  switch (status.state) {
    case "syncing":
      return {
        icon: <LoaderCircleIcon className="size-3 animate-spin" />,
        label: "Syncing",
        detail: `Sending ${files ?? "changes"} to the cloud preview.`,
      }
    case "restarting":
      return {
        icon: <LoaderCircleIcon className="size-3 animate-spin" />,
        label: "Restarting",
        detail: status.reason ?? "Restarting the cloud preview.",
      }
    case "waiting":
      return {
        icon: <ClockIcon className="size-3" />,
        label: "Waiting",
        detail:
          status.reason ??
          "Local changes will be sent when the cloud preview is ready.",
      }
    case "error":
      return {
        icon: <TriangleAlertIcon className="size-3" />,
        label: "Sync error",
        detail: `${status.reason ?? "Local changes could not be sent."} Blame retries automatically.`,
      }
    default:
      return {
        icon: <CheckIcon className="size-3" />,
        label: "Synced",
        detail: status.syncedAt
          ? `Up to date. Last sent ${files ?? "changes"} ${elapsed(status.syncedAt, now)}.`
          : "Up to date with this computer.",
      }
  }
}

function fileCount(count: number | undefined) {
  if (count === undefined) return undefined
  return count === 1 ? "1 file" : `${count} files`
}

function elapsed(at: string, now: number) {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  return `at ${new Date(at).toLocaleTimeString()}`
}
