import * as React from "react"

import { isFiniteNumber, readUiMemory, writeUiMemory } from "@/lib/ui-memory"

const widthKey = "story-drawer-width"
const minWidthPx = 640
// The drawer sits against the window's right edge and leaves the app at
// least this much on the left.
const leftGapPx = 16

// The story drawer remembers the width the user dragged it to.
export function useStoryDrawerWidth() {
  const [width, setWidth] = React.useState(() =>
    readUiMemory(widthKey, isFiniteNumber)
  )
  const style = width
    ? ({ "--story-drawer-width": `${width}px` } as React.CSSProperties)
    : undefined
  return { setWidth, style, width }
}

export function DrawerResizeHandle({
  onWidthChange,
}: {
  onWidthChange(width: number | undefined): void
}) {
  const [dragging, setDragging] = React.useState(false)

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    // Not stopped: the drawer's outside-click tracking must see this press,
    // or it takes the next click outside for one inside and stays open.
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    setDragging(true)
    let latest: number | undefined
    const move = (moveEvent: PointerEvent) => {
      latest = clampWidth(window.innerWidth - moveEvent.clientX)
      onWidthChange(latest)
    }
    const stop = () => {
      setDragging(false)
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", stop)
      handle.removeEventListener("pointercancel", stop)
      if (latest) writeUiMemory(widthKey, latest)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", stop)
    handle.addEventListener("pointercancel", stop)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const drawer = event.currentTarget.parentElement
    const current = drawer?.getBoundingClientRect().width ?? minWidthPx
    const next = clampWidth(current + (event.key === "ArrowLeft" ? 48 : -48))
    onWidthChange(next)
    writeUiMemory(widthKey, next)
  }

  return (
    <div
      role="separator"
      aria-label="Resize panel"
      aria-orientation="vertical"
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      data-dragging={dragging || undefined}
      className="group/resize absolute inset-y-0 left-0 z-40 flex w-3 cursor-col-resize touch-none justify-center outline-none"
      onDoubleClick={() => {
        onWidthChange(undefined)
        writeUiMemory(widthKey, null)
      }}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
    >
      <span className="my-auto h-12 w-1 rounded-full bg-border opacity-0 transition-[opacity,height] duration-200 group-hover/resize:h-20 group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100 group-data-dragging/resize:h-28 group-data-dragging/resize:bg-primary/60 group-data-dragging/resize:opacity-100" />
    </div>
  )
}

function clampWidth(width: number) {
  const max = window.innerWidth - leftGapPx
  return Math.round(Math.max(Math.min(width, max), Math.min(minWidthPx, max)))
}
