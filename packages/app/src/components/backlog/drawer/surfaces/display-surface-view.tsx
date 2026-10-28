import * as React from "react"
import RFB from "@novnc/novnc/core/rfb.js"
import { ClipboardPasteIcon, CameraIcon, RotateCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { usePlatform } from "@/context/platform"
import type { PreviewSurfaceScope } from "@/context/platform-preview-surfaces"
import { SurfaceUnavailable } from "./surface-unavailable"

export function DisplaySurfaceView({
  scope,
  active,
  onRestart,
}: {
  scope: PreviewSurfaceScope
  active: boolean
  onRestart?: () => void
}) {
  const client = usePlatform().previewSurfaces
  const container = React.useRef<HTMLDivElement>(null)
  const connection = React.useRef<RFB | undefined>(undefined)
  const [message, setMessage] = React.useState<string>()
  const [attempt, retry] = React.useReducer((n) => n + 1, 0)
  React.useEffect(() => {
    if (!active || !client || !container.current) return
    let cancelled = false
    let rfb: RFB | undefined
    setMessage(undefined)
    void client
      .open(scope)
      .then(({ url }) => {
        if (cancelled || !container.current) return
        rfb = new RFB(container.current, url)
        rfb.scaleViewport = true
        rfb.resizeSession = false
        rfb.addEventListener("disconnect", () => {
          if (!cancelled)
            setMessage("The screen disconnected. Reconnect to continue.")
        })
        connection.current = rfb
      })
      .catch((error: Error) => {
        if (!cancelled) setMessage(error.message)
      })
    return () => {
      cancelled = true
      rfb?.disconnect()
      connection.current = undefined
    }
  }, [
    client,
    scope.storyId,
    scope.serviceId,
    scope.worktree,
    scope.sessionId,
    active,
    attempt,
  ])
  const screenshot = async () => {
    const result = await client?.action(scope, { action: "screenshot" })
    const image = result?.content?.find((item) => item.type === "image")
    if (!image) {
      setMessage(
        result?.message ?? "The screenshot could not be captured. Try again."
      )
      return
    }
    const link = document.createElement("a")
    link.href = `data:image/png;base64,${image.data}`
    link.download = "preview.png"
    link.click()
  }
  return (
    <div className="flex h-full min-h-64 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={onRestart}
          disabled={!onRestart}
        >
          <RotateCwIcon />
          Restart app
        </Button>
        <select
          aria-label="Screen resolution"
          className="rounded-md border bg-background px-2 py-1 text-sm"
          defaultValue="1280x800"
          disabled={!onRestart}
          onChange={(event) => {
            const [width, height] = event.target.value.split("x").map(Number)
            void client
              ?.action(scope, { action: "resolution", width, height })
              .then((result) => {
                if (result.status === "ready") onRestart?.()
                else setMessage(result.message)
              })
          }}
        >
          <option value="1280x800">1280 × 800</option>
          <option value="1440x900">1440 × 900</option>
          <option value="1920x1080">1920 × 1080</option>
        </select>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void navigator.clipboard
              .readText()
              .then((text) => connection.current?.clipboardPasteFrom(text))
              .catch(() =>
                setMessage(
                  "Clipboard access was denied. Paste with the keyboard instead."
                )
              )
          }
        >
          <ClipboardPasteIcon />
          Paste
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void screenshot().catch((error: Error) => setMessage(error.message))
          }
        >
          <CameraIcon />
          Screenshot
        </Button>
      </div>
      {message && (
        <SurfaceUnavailable
          message={message}
          action="Reconnect"
          onAction={retry}
        />
      )}
      <div
        ref={container}
        onPointerDown={() => connection.current?.focus()}
        className="min-h-0 flex-1 overflow-hidden"
        aria-label="Application screen"
      />
    </div>
  )
}
