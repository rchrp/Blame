import {
  RotateCwIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { readableFailure } from "./preview-failure-message"

// A failed preview start stays explained in the preview itself, with the
// actions that can fix it, instead of only in a toast that disappears.

export function PreviewFailurePanel({
  message,
  onOpenLogs,
  onRestart,
  repair,
  restarting,
}: {
  message: string
  onOpenLogs: () => void
  onRestart: () => void
  repair?: { label: string; onClick: () => void }
  restarting?: boolean
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/20 px-4 pt-[72px] pb-4">
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-auto rounded-lg border bg-background p-8 text-center"
        role="alert"
      >
        <TriangleAlertIcon className="size-8 text-destructive" />
        <div className="max-w-xl space-y-2">
          <h3 className="font-heading text-lg font-semibold">
            The preview could not start
          </h3>
          <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
            {readableFailure(message)}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {repair && (
            <Button size="sm" onClick={repair.onClick}>
              <WrenchIcon />
              {repair.label}
            </Button>
          )}
          <Button
            disabled={restarting}
            size="sm"
            variant={repair ? "outline" : "default"}
            onClick={onRestart}
          >
            <RotateCwIcon />
            Restart
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenLogs}>
            <ScrollTextIcon />
            Run logs
          </Button>
        </div>
      </div>
    </div>
  )
}
