import * as React from "react"

import {
  sliderPoint,
  type NotchDirection,
} from "@/lib/notched-slider"
import { cn } from "@/lib/utils"

export type NotchedSliderColor = "blue" | "green" | "violet" | "amber" | "rose"

export type WheelDirection = NotchDirection

export function useWheelStep<Element extends HTMLElement = HTMLButtonElement>(
  onStep: (direction: WheelDirection) => void
): React.WheelEventHandler<Element> {
  const lastStepAt = React.useRef(-Infinity)
  return React.useCallback(
    (event) => {
      if (event.deltaY === 0) return
      event.preventDefault()
      event.stopPropagation()
      if (event.timeStamp - lastStepAt.current < 80) return
      lastStepAt.current = event.timeStamp
      onStep(event.deltaY > 0 ? 1 : -1)
    },
    [onStep]
  )
}

export function reverseWheelDirection(
  direction: WheelDirection
): WheelDirection {
  return direction === 1 ? -1 : 1
}

type NotchedSliderProps = {
  ariaLabel: string
  ariaValueText?: string
  // Blue unless the slider belongs to a setting with a color of its own.
  color?: NotchedSliderColor
  // The positions, from 0 to 1, the thumb can rest on.
  markers: readonly number[]
  // Where the thumb rests, from 0 to 1.
  position: number
  // Called with the raw position while the thumb is dragged or nudged.
  onChange: (rawPosition: number) => void
  // One notch toward the right (1) or the left (-1): arrow keys and the wheel.
  onStep: (direction: WheelDirection) => void
}

// A slider whose thumb rests on a few notches. It has a colored fill that
// grows with the position, and takes the keyboard, the wheel and the pointer.
export function NotchedSlider({
  ariaLabel,
  ariaValueText,
  color = "blue",
  markers,
  position,
  onChange,
  onStep,
}: NotchedSliderProps) {
  const onWheel = useWheelStep<HTMLDivElement>((direction) =>
    onStep(reverseWheelDirection(direction))
  )
  const control = useNotchedSliderControl(position, onChange)
  return (
    <div className="relative h-8" onWheel={onWheel}>
      <SliderTrack color={color} position={position} />
      <SliderMarkers markers={markers} position={position} />
      <SliderRangeInput
        ariaLabel={ariaLabel}
        ariaValueText={ariaValueText}
        control={control}
        onStep={onStep}
      />
      <SliderThumb position={position} />
    </div>
  )
}

// The input follows the pointer freely while it is dragged, then settles on
// the position the slider rests on.
function useNotchedSliderControl(
  position: number,
  onChange: (rawPosition: number) => void
) {
  const [inputPosition, setInputPosition] = React.useState(position)
  const change = (rawPosition: number) => {
    setInputPosition(rawPosition)
    onChange(rawPosition)
  }
  const settle = () => setInputPosition(position)
  return { change, inputPosition, settle }
}

const stepKeys: Record<string, WheelDirection> = {
  ArrowDown: -1,
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: 1,
  PageDown: -1,
  PageUp: 1,
}

function SliderRangeInput({
  ariaLabel,
  ariaValueText,
  control,
  onStep,
}: {
  ariaLabel: string
  ariaValueText?: string
  control: ReturnType<typeof useNotchedSliderControl>
  onStep: (direction: WheelDirection) => void
}) {
  return (
    <input
      aria-label={ariaLabel}
      aria-valuetext={ariaValueText}
      className="peer absolute inset-0 z-10 h-full w-full cursor-grab opacity-0 active:cursor-grabbing"
      max={1000}
      min={0}
      type="range"
      value={Math.round(control.inputPosition * 1000)}
      onBlur={control.settle}
      onChange={(event) =>
        control.change(Number(event.currentTarget.value) / 1000)
      }
      onKeyDown={(event) => {
        const direction = stepKeys[event.key]
        if (!direction) return
        event.preventDefault()
        onStep(direction)
      }}
      onKeyUp={control.settle}
      onPointerUp={control.settle}
    />
  )
}

type SliderFillStyle = React.CSSProperties & { "--smart-position": number }

function sliderFillStyle(position: number): SliderFillStyle {
  return { "--smart-position": position, width: sliderPoint(position) }
}

function SliderTrack({
  color,
  position,
}: {
  color: NotchedSliderColor
  position: number
}) {
  return (
    <div
      className={cn(
        "smart-model-slider-track pointer-events-none absolute inset-x-0 top-1/2 h-[18px] -translate-y-1/2 rounded-full",
        `notched-slider-${color}`
      )}
    >
      <span
        className="smart-model-slider-fill absolute inset-y-0 left-0 overflow-hidden rounded-full transition-[width,box-shadow] duration-300 ease-out motion-reduce:transition-none"
        style={sliderFillStyle(position)}
      />
    </div>
  )
}

function SliderThumb({ position }: { position: number }) {
  return (
    <span
      className="pointer-events-none absolute top-1/2 z-2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-md ring-2 ring-neutral-900 dark:ring-background transition-[left,scale,box-shadow] duration-200 ease-out peer-hover:scale-125 peer-hover:shadow-lg peer-focus-visible:scale-125 peer-active:scale-125 peer-active:shadow-xl motion-reduce:transition-none"
      style={{ left: sliderPoint(position) }}
    />
  )
}

function SliderMarkers({
  markers,
  position,
}: {
  markers: readonly number[]
  position: number
}) {
  return markers.map((marker, index) =>
    Math.abs(marker - position) < 0.025 ? null : (
      <span
        key={index}
        className="pointer-events-none absolute top-1/2 z-1 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/30"
        style={{ left: sliderPoint(marker) }}
      />
    )
  )
}
