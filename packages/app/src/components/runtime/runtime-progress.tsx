import type { RuntimeProgress } from "@/context/platform"
import { useAnimatedBorderEffect } from "@/hooks/use-animated-border-effect"
import { runtimeProgressText } from "@/lib/blame-runtime-state"

// Body of the install/update notification: what is happening and how far it
// got. The filled part carries the same travelling light as the border of
// a story an agent is working on.
export function RuntimeProgressBody({ progress }: { progress?: RuntimeProgress }) {
  const percent = progress?.percent
  const known = percent !== undefined
  const glowRef = useAnimatedBorderEffect("story-progress")

  return (
    <div className="grid w-[16.5rem] max-w-full gap-2 pt-0.5">
      <span>{runtimeProgressText(progress)}</span>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(percent) : undefined}
        className="runtime-progress-track"
      >
        <div
          ref={glowRef}
          data-indeterminate={known ? undefined : true}
          className="runtime-progress-fill"
          style={known ? { width: `${Math.max(4, Math.min(percent, 100))}%` } : undefined}
        />
      </div>
    </div>
  )
}
