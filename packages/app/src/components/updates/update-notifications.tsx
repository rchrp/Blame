import * as React from "react"
import { toast } from "sonner"

import { ProgressNotificationBody } from "@/components/shared/progress-notification"
import { Button } from "@/components/ui/button"
import { useDesktopUpdates } from "./desktop-updates-provider"

const toastId = "blame-desktop-update"
const options = {
  id: toastId,
  position: "bottom-right" as const,
  duration: Infinity,
  className: "progress-notification-toast",
  closeButton: false,
  dismissible: true,
}

export function UpdateNotifications() {
  const { status, pending, failure, download, restart, retry } =
    useDesktopUpdates()
  const lastNotification = React.useRef("")
  const notificationShown = React.useRef(false)

  React.useEffect(() => {
    const view = failure
      ? "error"
      : pending === "restart"
        ? "restarting"
        : pending === "download" || status.phase === "downloading"
          ? "progress"
          : status.phase
    const key = JSON.stringify([
      view,
      status.latestVersion,
      view === "progress" ? [status.phase, status.progress] : undefined,
      failure,
    ])
    if (lastNotification.current === key) return
    lastNotification.current = key
    const version = status.latestVersion ? ` ${status.latestVersion}` : ""

    if (
      !failure &&
      !["restarting", "downloaded", "progress", "available"].includes(view)
    ) {
      // Sonner defers dismissal by a frame. Dismissing before the first status
      // arrives could otherwise remove the notification we are about to show.
      if (notificationShown.current) toast.dismiss(toastId)
      notificationShown.current = false
      return
    }
    notificationShown.current = true

    if (failure) {
      toast.error("Blame couldn't update", {
        ...options,
        description: (
          <UpdateNotice
            message={failure.message}
            action="Retry"
            onAction={retry}
          />
        ),
      })
    } else if (pending === "restart") {
      toast.loading("Restarting Blame…", {
        ...options,
        dismissible: false,
        description: "Preparing to restart and finish the update.",
      })
    } else if (view === "downloaded") {
      toast.success("Ready to restart", {
        ...options,
        description: (
          <UpdateNotice
            message={`Blame${version} is ready. Restart now, or keep working and the update will finish when you next quit Blame.`}
            action="Restart now"
            onAction={restart}
          />
        ),
      })
    } else if (view === "progress") {
      const percent =
        status.phase === "downloading" ? status.progress : undefined
      const label =
        status.phase === "downloaded"
          ? "Preparing the update…"
          : percent === undefined
            ? "Getting the update ready…"
            : percent >= 100
              ? "Preparing the update…"
              : `Downloading update · ${Math.round(percent)}%`
      toast.loading("Updating Blame", {
        ...options,
        dismissible: false,
        description: (
          <ProgressNotificationBody label={label} percent={percent} />
        ),
      })
    } else if (status.phase === "available") {
      toast.info("Update available", {
        ...options,
        description: (
          <UpdateNotice
            message={`Blame${version} is available. Install the update in the background and keep working.`}
            action="Install update"
            onAction={download}
          />
        ),
      })
    }
  }, [status, pending, failure, download, restart, retry])

  React.useEffect(
    () => () => {
      lastNotification.current = ""
      if (notificationShown.current) toast.dismiss(toastId)
      notificationShown.current = false
    },
    []
  )
  return null
}

function UpdateNotice({
  message,
  action,
  onAction,
}: {
  message: string
  action: string
  onAction(): Promise<void>
}) {
  return (
    <div className="grid gap-3">
      <p>{message}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void onAction()}>
          {action}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => toast.dismiss(toastId)}
        >
          Later
        </Button>
      </div>
    </div>
  )
}
