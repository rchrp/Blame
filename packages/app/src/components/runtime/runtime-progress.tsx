import type { RuntimeProgress } from "@/context/platform"
import { ProgressNotificationBody } from "@/components/shared/progress-notification"
import { runtimeProgressText } from "@/lib/blame-runtime-state"

export function RuntimeProgressBody({
  progress,
}: {
  progress?: RuntimeProgress
}) {
  return (
    <ProgressNotificationBody
      label={runtimeProgressText(progress)}
      percent={progress?.percent}
    />
  )
}
