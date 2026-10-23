import type {
  PreviewLifecyclePhase,
  PreviewLifecycleState,
} from "@blame/agent-runtime"
import { CheckIcon, LoaderCircleIcon } from "lucide-react"
import * as React from "react"

import {
  formatStepDuration,
  nextPreviewStartHistory,
  type PreviewStartHistory,
} from "./preview-start-steps"

const visibleSteps = 5

export function PreviewInitializationState({
  lifecycle,
}: {
  lifecycle?: PreviewLifecycleState
} = {}) {
  const copy = previewLifecycleCopy(lifecycle?.phase)
  const current = lifecycle?.step ?? copy.title
  const now = useNow()
  const [history, setHistory] = React.useState<PreviewStartHistory>({
    steps: [],
  })
  const next = nextPreviewStartHistory(history, lifecycle?.since, current, now)
  if (next !== history) setHistory(next)
  const steps = next.steps.slice(-visibleSteps)
  const startedAt = lifecycle?.since ? Date.parse(lifecycle.since) : undefined
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-5 bg-background p-8 text-center">
      <div className="space-y-1">
        <h3 className="font-heading text-lg font-semibold">{copy.title}</h3>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
      </div>
      <ol className="flex w-full max-w-sm flex-col gap-1.5 text-left text-sm">
        {steps.map((step, index) => {
          const done = index < steps.length - 1
          const endedAt = done ? steps[index + 1]!.startedAt : now
          return (
            <li
              key={`${step.label}-${step.startedAt}`}
              className="flex items-center gap-2 data-[done=true]:text-muted-foreground"
              data-done={done}
            >
              {done ? (
                <CheckIcon className="size-3.5 shrink-0" />
              ) : (
                <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
              )}
              <span className="min-w-0 flex-1 truncate">{step.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatStepDuration(endedAt - step.startedAt)}
              </span>
            </li>
          )
        })}
      </ol>
      {startedAt !== undefined && Number.isFinite(startedAt) && (
        <p className="text-xs text-muted-foreground tabular-nums">
          Started {formatStepDuration(now - startedAt)} ago
        </p>
      )}
    </div>
  )
}

function useNow() {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

function previewLifecycleCopy(phase: PreviewLifecyclePhase | undefined) {
  switch (phase) {
    case "provisioning":
      return {
        title: "Provisioning preview",
        description: "Creating the isolated preview environment.",
      }
    case "resuming":
      return {
        title: "Resuming preview",
        description: "Restoring the isolated preview environment.",
      }
    case "synchronizing":
      return {
        title: "Synchronizing preview",
        description: "Sending the current story workspace to the runtime.",
      }
    case "loading":
      return {
        title: "Loading preview",
        description: "Publishing and checking the preview endpoint.",
      }
    case "preparing":
      return {
        title: "Preparing preview",
        description: "Preparing containers and runtime dependencies.",
      }
    case "starting":
      return {
        title: "Starting preview",
        description: "Starting services and waiting for readiness checks.",
      }
    default:
      return {
        title: "Initializing preview",
        description: "Preparing the isolated worktree and its containers.",
      }
  }
}
