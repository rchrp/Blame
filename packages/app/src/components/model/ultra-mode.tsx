import * as React from "react"
import { ZapIcon } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

// Ultra mode: the agent may start helper agents while it works on a message.
// It is chosen for each message from the composer's reasoning menu, and the
// message records that it was on.

export type UltraControl = {
  checked: boolean
  onCheckedChange(checked: boolean): void
}

export const ultraExplanation =
  "Starts helper agents in parallel. Uses more tokens."

/** What the menu says where the model cannot run helpers. */
export const ultraUnavailableReason = "Not available with Claude Code."

/** The small marker of a composer or a message that has ultra mode on. */
export function UltraMark({
  className,
  compact = false,
  label = "Ultra",
}: {
  className?: string
  /** Under a narrow window the word goes and the icon stays, for screen readers too. */
  compact?: boolean
  label?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-px text-xs leading-4 font-medium text-primary dark:bg-blue-400/15 dark:text-blue-300",
        className
      )}
    >
      <ZapIcon className="size-3" aria-hidden="true" />
      <span className={cn(compact && "max-sm:sr-only")}>{label}</span>
    </span>
  )
}

/** The menu item: a checkbox, its name and one line of what it does. */
export function UltraToggle({
  checked,
  onCheckedChange,
  unavailable,
}: UltraControl & { unavailable?: string }) {
  const description = React.useId()
  return (
    <label
      className={cn(
        "flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors",
        unavailable
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:bg-foreground/10"
      )}
    >
      <Checkbox
        aria-describedby={description}
        checked={checked && !unavailable}
        className="mt-0.5"
        disabled={Boolean(unavailable)}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <span className="grid gap-0.5">
        <span className="text-sm font-medium">Ultra mode</span>
        <span className="text-xs text-muted-foreground" id={description}>
          {unavailable ?? ultraExplanation}
        </span>
      </span>
    </label>
  )
}
