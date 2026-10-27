import { useAnimatedBorderEffect } from "@/hooks/use-animated-border-effect"

// Shared by runtime maintenance, desktop updates and project initialization.
export function ProgressNotificationBody({
  label,
  percent,
  detail,
}: {
  label: string
  percent?: number
  /** A second, quieter line about the current step. */
  detail?: string
}) {
  const value =
    percent !== undefined && Number.isFinite(percent)
      ? Math.max(0, Math.min(percent, 100))
      : undefined
  const glowRef = useAnimatedBorderEffect("story-progress")

  return (
    <div className="grid w-full gap-2 pt-0.5">
      <span>{label}</span>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value === undefined ? undefined : Math.round(value)}
        className="notification-progress-track"
      >
        <div
          ref={glowRef}
          data-indeterminate={value === undefined ? true : undefined}
          className="notification-progress-fill"
          style={
            value === undefined
              ? undefined
              : { width: `${Math.max(4, value)}%` }
          }
        />
      </div>
      {detail ? (
        <span className="text-xs text-muted-foreground">{detail}</span>
      ) : null}
    </div>
  )
}
