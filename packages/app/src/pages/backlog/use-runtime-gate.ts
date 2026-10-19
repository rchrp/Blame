import * as React from "react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { useBlameRuntime } from "@/context/blame-runtime"
import { runtimeBlocksNewRuns } from "@/lib/blame-runtime-state"
import type { StoryRunMode } from "@/lib/runtime-preference"

export type RuntimeGateDecision = "go" | "wait" | "needs-runtime"

// Decides whether a queued story can start given the Blame Runtime, and
// tells the runtime how many local stories are running so updates wait for
// them. Only Local Container stories depend on the runtime.
export function useRuntimeGate({
  onRuntimeReady,
  runModeOf,
  stories,
}: {
  onRuntimeReady(): void
  // Where each story runs; only Local Container needs the runtime.
  runModeOf(story: UserStory): StoryRunMode
  stories: readonly UserStory[]
}) {
  const runtime = useBlameRuntime()
  const { phase, promptInstall, setLocalRunsActive } = runtime
  const phaseRef = React.useRef(phase)
  const prompted = React.useRef(new Set<string>())
  const onReadyRef = React.useRef(onRuntimeReady)
  const localRuns = stories.filter(localStoryRunning).length

  React.useEffect(() => {
    phaseRef.current = phase
    onReadyRef.current = onRuntimeReady
  })

  React.useEffect(() => {
    setLocalRunsActive(localRuns)
  }, [localRuns, setLocalRunsActive])

  // Stories held for the runtime start as soon as it is ready.
  React.useEffect(() => {
    if (phase !== "ready") return
    prompted.current.clear()
    onReadyRef.current()
  }, [phase])

  const gate = React.useCallback(
    (story: UserStory): RuntimeGateDecision => {
      const current = phaseRef.current
      if (runModeOf(story) !== "local-container") return "go"
      if (current === "ready" || current === "unavailable") return "go"
      if (runtimeBlocksNewRuns(current)) return "wait"
      // Missing or broken: ask once per story, then keep it queued.
      if (!prompted.current.has(story.id)) {
        prompted.current.add(story.id)
        promptInstall({ storyTitle: story.title })
      }
      return "needs-runtime"
    },
    [promptInstall, runModeOf]
  )

  return {
    gate,
    // Older desktop builds cannot report the runtime state: let the host
    // check include it as before.
    hostCheckIncludesRuntime: phase === "unavailable" ? undefined : false,
    waitingLabel:
      runtimeBlocksNewRuns(phase) &&
      stories.some(
        (story) =>
          story.status === "ready" && runModeOf(story) === "local-container"
      )
        ? runtimeWaitingLabel(phase)
        : undefined,
  }
}

function localStoryRunning(story: UserStory) {
  return (
    story.status === "in-progress" &&
    story.agentStatus === "Running" &&
    story.workspaceMode === "local-container"
  )
}

function runtimeWaitingLabel(phase: string) {
  if (phase === "checking") return "Checking Blame Runtime"
  if (phase === "installing") return "Waiting for Blame Runtime to install"
  if (phase === "repairing") return "Waiting for Blame Runtime repair"
  return "Waiting for Blame Runtime update"
}
