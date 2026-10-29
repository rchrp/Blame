import * as React from "react"
import { AppWindowIcon, PlayIcon, SquareIcon, RotateCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { usePlatform } from "@/context/platform"
import { navigate } from "@/components/navigation/navigation"
import { SurfaceUnavailable } from "./surface-unavailable"
import { terminalText } from "@/lib/terminal-text"

export type HostWindowPanelProps = {
  mode: "direct" | "local-container" | "cloud-mirror"
  status?: string
  logs?: string
  onStart?(): void
  onStop?(): void
  onRestart?(): void
}
export function HostWindowPanel({
  mode,
  status = "stopped",
  logs,
  onStart,
  onStop,
  onRestart,
}: HostWindowPanelProps) {
  const platform = usePlatform(),
    [enabled, setEnabled] = React.useState(false)
  React.useEffect(() => {
    let cancelled = false
    void platform.previewSurfaces?.enabled().then((values) => {
      if (!cancelled) setEnabled(values.includes("host-window"))
    })
    return () => {
      cancelled = true
    }
  }, [platform.previewSurfaces])
  if (mode !== "direct")
    return (
      <SurfaceUnavailable
        message="This app runs on your computer only. Work on it in a Direct story to try it."
        action="Review setup"
        onAction={() => navigate("/initialization")}
      />
    )
  if (!enabled)
    return (
      <SurfaceUnavailable
        message="App window previews are not enabled on this computer."
        action="Review setup"
        onAction={() => navigate("/initialization")}
      />
    )
  const running = status === "running",
    busy = status === "starting" || status === "stopping"
  return (
    <div className="flex h-full min-h-64 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="mr-auto text-sm text-muted-foreground" role="status">
          {status === "error"
            ? "The app stopped with an error"
            : status[0]!.toUpperCase() + status.slice(1)}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={running || busy || !onStart}
          onClick={onStart}
        >
          <PlayIcon />
          Start
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!running || busy || !onStop}
          onClick={onStop}
        >
          <SquareIcon />
          Stop
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !onRestart}
          onClick={onRestart}
        >
          <RotateCwIcon />
          Restart
        </Button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <AppWindowIcon className="size-8 text-muted-foreground" />
        <h3 className="font-heading text-lg font-semibold">
          This app opens in its own window.
        </h3>
        <p className="max-w-md text-sm text-muted-foreground">
          Use the app on your computer to check its interface. Its run status
          and logs appear here.
        </p>
      </div>
      <pre
        aria-label="Application logs"
        className="max-h-[50%] min-h-32 overflow-auto border-t bg-muted/20 p-4 text-xs whitespace-pre-wrap"
      >
        {terminalText(logs?.slice(-64000) ?? "") ||
          "Run the app to see its logs."}
      </pre>
    </div>
  )
}
