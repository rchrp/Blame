import { DownloadIcon, LoaderCircleIcon, RotateCcwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useDesktopUpdates } from "./desktop-updates-provider"

export function SidebarUpdateButton() {
  const { status, pending, failure, download, restart, retry } =
    useDesktopUpdates()
  const busy = Boolean(pending) || status.phase === "downloading"
  const ready = status.phase === "downloaded"
  if (!busy && !ready && !failure && status.phase !== "available") return null

  const label = failure
    ? failure.action === "restart"
      ? "Retry restarting Blame"
      : "Retry Blame update"
    : pending === "restart"
      ? "Restarting Blame"
      : busy
        ? "Updating Blame"
        : ready
          ? "Restart to update Blame"
          : "Install Blame update"
  const Icon = busy ? LoaderCircleIcon : ready ? RotateCcwIcon : DownloadIcon
  const action = failure ? retry : ready ? restart : download

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          aria-label={label}
          aria-disabled={busy}
          className="mr-1 rounded-full bg-blue-500 text-white hover:bg-blue-600 focus-visible:ring-blue-400/60"
          onClick={() => {
            if (!busy) void action()
          }}
        >
          <Icon
            className={
              busy ? "animate-spin motion-reduce:animate-none" : undefined
            }
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}
