import * as React from "react"

import { NotchedSlider } from "@/components/ui/notched-slider"
import {
  nearestMarkerIndex,
  notchPositions,
  steppedNotchIndex,
} from "@/lib/notched-slider"
import {
  notchAt,
  notchIndex,
  personalizationDefinitions,
  type PersonalizationSetting,
} from "@/lib/personalization"
import { cn } from "@/lib/utils"

const notchCount = 3
const markers = notchPositions(notchCount)

type PersonalizationSliderProps = {
  setting: PersonalizationSetting
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  // Under the description: what sets this value apart (the menu says when a
  // story or conversation differs from the default).
  footer?: React.ReactNode
  className?: string
}

// One setting with three notches, its color, and a sentence on how the agent
// behaves at the notch it rests on.
export function PersonalizationSlider({
  setting,
  value,
  onChange,
  disabled,
  footer,
  className,
}: PersonalizationSliderProps) {
  const definition = personalizationDefinitions[setting]
  const index = notchIndex(setting, value)
  const notch = notchAt(setting, index)

  function select(nextIndex: number) {
    if (disabled || nextIndex === index) return
    onChange(notchAt(setting, nextIndex).value)
  }

  return (
    <div
      className={cn("grid gap-1.5", disabled && "opacity-60", className)}
      inert={disabled}
    >
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{definition.label}</span>
        <span className="text-muted-foreground">{notch.label}</span>
      </div>
      <NotchedSlider
        ariaLabel={definition.label}
        ariaValueText={notch.label}
        color={definition.color}
        markers={markers}
        position={markers[index]!}
        onChange={(rawPosition) =>
          select(nearestMarkerIndex(markers, rawPosition) ?? index)
        }
        onStep={(direction) =>
          select(steppedNotchIndex(index, direction, notchCount))
        }
      />
      <p
        aria-live="polite"
        className="min-h-8 text-xs text-pretty text-muted-foreground"
      >
        {notch.description}
      </p>
      {footer}
    </div>
  )
}
