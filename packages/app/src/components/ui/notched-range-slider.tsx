import * as React from "react"

import { nearestMarkerIndex } from "@/lib/notched-slider"
import { cn } from "@/lib/utils"
import { NotchedSliderThumb, NotchedSliderTrack } from "./notched-slider"

export type NotchedRange = { min: number; max: number }

type Handle = "min" | "max"

type NotchedRangeSliderProps = {
  ariaLabel: string
  // The positions, from 0 to 1, both handles can rest on.
  markers: readonly number[]
  range: NotchedRange
  onChange: (range: NotchedRange) => void
  // What each handle stands for, for screen readers.
  valueText?: (handle: Handle, position: number) => string
}

const stepKeys: Record<string, -1 | 1> = {
  ArrowDown: -1,
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: 1,
  PageDown: -1,
  PageUp: 1,
}

// Both handles rest on notches and may meet on one. The nearer handle follows
// the pointer, and arrow keys move the focused handle by one notch.
export function NotchedRangeSlider({
  ariaLabel,
  markers,
  range,
  onChange,
  valueText,
}: NotchedRangeSliderProps) {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = React.useState<Handle>()
  const minIndex = nearestMarkerIndex(markers, range.min) ?? 0
  const maxIndex = nearestMarkerIndex(markers, range.max) ?? markers.length - 1

  function positionAt(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 32) return 0
    // The thumbs' centers run from 16px to width - 16px (sliderPoint).
    return Math.min(
      1,
      Math.max(0, (clientX - rect.left - 16) / (rect.width - 32))
    )
  }

  function moveTo(handle: Handle, index: number) {
    const clamped =
      handle === "min" ? Math.min(index, maxIndex) : Math.max(index, minIndex)
    const position = markers[clamped]
    if (position === undefined) return
    const next = { ...range, [handle]: position }
    if (next.min !== range.min || next.max !== range.max) onChange(next)
  }

  function nearerHandle(position: number): Handle {
    const toMin = Math.abs(position - (markers[minIndex] ?? 0))
    const toMax = Math.abs(position - (markers[maxIndex] ?? 1))
    if (toMin === toMax)
      return position < (markers[minIndex] ?? 0) ? "min" : "max"
    return toMin < toMax ? "min" : "max"
  }

  function follow(handle: Handle, clientX: number) {
    const index = nearestMarkerIndex(markers, positionAt(clientX))
    if (index !== undefined) moveTo(handle, index)
  }

  const minPosition = markers[minIndex] ?? 0
  const maxPosition = markers[maxIndex] ?? 1

  return (
    <div
      ref={trackRef}
      aria-label={ariaLabel}
      className="relative h-8 touch-none select-none"
      role="group"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        const handle = nearerHandle(positionAt(event.clientX))
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(handle)
        follow(handle, event.clientX)
        event.currentTarget
          .querySelector<HTMLElement>(`[data-handle="${handle}"]`)
          ?.focus()
        event.preventDefault()
      }}
      onPointerMove={(event) => {
        if (dragging) follow(dragging, event.clientX)
      }}
      onPointerUp={() => setDragging(undefined)}
      onPointerCancel={() => setDragging(undefined)}
    >
      <NotchedSliderTrack
        markers={markers}
        start={minPosition}
        end={maxPosition}
      />
      {(["min", "max"] as const).map((handle) => {
        const position = handle === "min" ? minPosition : maxPosition
        const index = handle === "min" ? minIndex : maxIndex
        return (
          <NotchedSliderThumb
            key={handle}
            aria-label={
              handle === "min"
                ? "Cheapest model allowed"
                : "Smartest model allowed"
            }
            aria-orientation="horizontal"
            aria-valuemax={1000}
            aria-valuemin={0}
            aria-valuenow={Math.round(position * 1000)}
            aria-valuetext={valueText?.(handle, position)}
            className={cn(
              "cursor-grab outline-none hover:scale-125 focus-visible:scale-125 focus-visible:ring-ring",
              dragging === handle && "scale-125 cursor-grabbing",
              // Met on one notch: the max handle stays on top to pull right.
              handle === "max" ? "z-3" : "z-2"
            )}
            data-handle={handle}
            role="slider"
            position={position}
            tabIndex={0}
            onKeyDown={(event) => {
              const direction = stepKeys[event.key]
              if (event.key === "Home") moveTo(handle, 0)
              else if (event.key === "End") moveTo(handle, markers.length - 1)
              else if (direction) moveTo(handle, index + direction)
              else return
              event.preventDefault()
            }}
          />
        )
      })}
    </div>
  )
}
