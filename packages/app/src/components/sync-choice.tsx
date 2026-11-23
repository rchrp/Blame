import * as React from "react"
import { CloudIcon, HardDriveIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export type SyncChoiceValue = "account" | "device"

/**
 * Where something the person sets up is kept: in their Blame account (their
 * other devices get it) or on this computer only. Two plain options and one
 * sentence about the one selected.
 */
export function SyncChoice({
  accountHint,
  accountLabel = "Save to my Blame account",
  deviceHint,
  deviceLabel = "Keep on this device only",
  deviceDisabled,
  disabled,
  label,
  onChange,
  value,
}: {
  accountHint: string
  accountLabel?: string
  deviceHint: string
  deviceLabel?: string
  deviceDisabled?: boolean
  disabled?: boolean
  label: string
  onChange(value: SyncChoiceValue): void
  value: SyncChoiceValue
}) {
  const id = React.useId()
  const options: {
    hint: string
    icon: React.ReactNode
    label: string
    value: SyncChoiceValue
  }[] = [
    {
      hint: accountHint,
      icon: <CloudIcon className="size-4" />,
      label: accountLabel,
      value: "account",
    },
    {
      hint: deviceHint,
      icon: <HardDriveIcon className="size-4" />,
      label: deviceLabel,
      value: "device",
    },
  ]
  return (
    <div>
      <div className="mb-2 text-sm font-medium" id={id}>
        {label}
      </div>
      <div
        role="radiogroup"
        aria-labelledby={id}
        className="grid gap-2 sm:grid-cols-2"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            disabled={disabled || (option.value === "device" && deviceDisabled)}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex items-start gap-2 rounded-lg border bg-background px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
              value === option.value
                ? "border-primary bg-primary/5"
                : "hover:bg-muted/50"
            )}
          >
            <span className="mt-0.5 text-muted-foreground">{option.icon}</span>
            <span>{option.label}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {options.find((option) => option.value === value)?.hint}
      </p>
    </div>
  )
}

/** A small, calm mark of where something is kept. */
export function SyncBadge({
  className,
  mode,
  onClick,
  title,
}: {
  className?: string
  mode: SyncChoiceValue
  onClick?(): void
  title?: string
}) {
  const content = (
    <>
      {mode === "account" ? (
        <CloudIcon className="size-3" />
      ) : (
        <HardDriveIcon className="size-3" />
      )}
      {mode === "account" ? "Synced" : "This device only"}
    </>
  )
  const classes = cn(
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground",
    onClick && "transition-colors hover:bg-muted",
    className
  )
  return onClick ? (
    <button type="button" className={classes} title={title} onClick={onClick}>
      {content}
    </button>
  ) : (
    <span className={classes} title={title}>
      {content}
    </span>
  )
}
