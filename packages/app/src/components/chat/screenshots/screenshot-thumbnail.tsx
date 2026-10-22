import { ImageOffIcon } from "lucide-react"

import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

import {
  useAgentScreenshot,
  type ScreenshotItem,
} from "./agent-screenshot-context"

const thumbnailHeight = 88
const thumbnailMaxWidth = 220

export function thumbnailWidth(item?: ScreenshotItem) {
  const width = item?.ref?.width
  const height = item?.ref?.height
  const ratio = width && height ? width / height : 16 / 10
  return Math.max(
    48,
    Math.min(thumbnailMaxWidth, Math.round(thumbnailHeight * ratio))
  )
}

// A screenshot under its tool call: small, cropped from the top, and a
// button that opens the full image.
export function ScreenshotThumbnail({
  item,
  onOpen,
}: {
  item: ScreenshotItem
  onOpen: () => void
}) {
  const state = useAgentScreenshot(item)
  const style = { height: thumbnailHeight, width: thumbnailWidth(item) }
  if (state.status === "loading")
    return <Skeleton className="rounded-lg" style={style} />
  if (state.status === "unavailable")
    return <ScreenshotUnavailable style={style} />
  const pageUrl =
    item.ref?.pageUrl || state.data.metadata.pageUrl || "the preview"
  return (
    <button
      type="button"
      aria-label={`Open screenshot of ${pageUrl}`}
      className="cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted shadow-xs transition-colors outline-none hover:border-foreground/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none"
      onClick={onOpen}
      style={style}
    >
      <img
        alt=""
        className="size-full object-cover object-top"
        draggable={false}
        loading="lazy"
        src={state.data.dataUrl}
      />
    </button>
  )
}

export function PendingScreenshot() {
  return (
    <div className="grid justify-items-start gap-1">
      <Skeleton
        className="rounded-lg"
        style={{ height: thumbnailHeight, width: thumbnailWidth() }}
      />
      <span className="text-xs text-muted-foreground">Capturing…</span>
    </div>
  )
}

// Shown when the image is neither on this device nor in the account.
export function ScreenshotUnavailable({
  className,
  style,
}: {
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-muted/40 p-2 text-center text-xs text-muted-foreground",
        className
      )}
      role="img"
      aria-label="Screenshot unavailable on this device"
      style={style}
    >
      <ImageOffIcon className="size-4 shrink-0" aria-hidden />
      <span>Screenshot unavailable on this device</span>
    </div>
  )
}
