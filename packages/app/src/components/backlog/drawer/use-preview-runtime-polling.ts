import type { ProjectPreviewRuntimeState } from "@blame/agent-runtime"
import * as React from "react"

import {
  previewRuntimePollDelay,
  samePreviewRuntimeState,
} from "@/components/backlog/drawer/preview-runtime-poll"
import { usePlatform } from "@/context/platform"

type PreviewRuntimeSetter = React.Dispatch<
  React.SetStateAction<ProjectPreviewRuntimeState | undefined>
>

// Keeps a story's local preview state current while its preview shows.
export function usePreviewRuntimePolling(
  workspace: ReturnType<typeof usePlatform>["workspace"],
  worktree: string | null | undefined,
  enabled: boolean,
  workspaceMode: "local-container" | "cloud-mirror",
  stopAfterConfigured: boolean,
  configuredCount: number | undefined,
  setRuntime: PreviewRuntimeSetter
) {
  const quickUntilRef = React.useRef(0)
  const pollSoonRef = React.useRef<(() => void) | undefined>(undefined)

  React.useEffect(() => {
    setRuntime(undefined)
  }, [enabled, setRuntime, workspace, workspaceMode, worktree])

  React.useEffect(() => {
    if (!enabled || !worktree || !workspace?.projectPreviewRuntimeState) return
    const polling = !(stopAfterConfigured && configuredCount)
    let cancelled = false
    let reading = false
    let timer: number | undefined
    let latest: ProjectPreviewRuntimeState | undefined
    // One read at a time; the next waits for the last one's answer.
    const refresh = () => {
      if (reading) return
      reading = true
      window.clearTimeout(timer)
      void readPreviewRuntime(workspace, worktree, workspaceMode).then(
        (next) => {
          reading = false
          if (cancelled) return
          if (next?.configurations.length) {
            latest = next
            setRuntime((current) =>
              samePreviewRuntimeState(current, next) ? current : next
            )
          }
          if (!polling) return
          timer = window.setTimeout(
            refresh,
            previewRuntimePollDelay({
              hidden: document.visibilityState === "hidden",
              now: Date.now(),
              quickUntil: quickUntilRef.current,
              runtime: latest,
            })
          )
        }
      )
    }
    const refreshWhenShown = () => {
      if (document.visibilityState !== "hidden") refresh()
    }
    pollSoonRef.current = () => {
      quickUntilRef.current = Date.now() + previewRuntimeQuickWindowMs
      refresh()
    }
    refresh()
    document.addEventListener("visibilitychange", refreshWhenShown)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", refreshWhenShown)
      pollSoonRef.current = undefined
    }
  }, [
    configuredCount,
    enabled,
    setRuntime,
    stopAfterConfigured,
    workspace,
    workspaceMode,
    worktree,
  ])

  // After an action, read soon and often until the preview settles.
  return React.useCallback(() => pollSoonRef.current?.(), [])
}

// An action's effect can take a moment to show in the preview's state.
const previewRuntimeQuickWindowMs = 20_000

async function readPreviewRuntime(
  workspace: ReturnType<typeof usePlatform>["workspace"],
  worktree: string,
  workspaceMode: "local-container" | "cloud-mirror"
) {
  try {
    return await workspace?.projectPreviewRuntimeState?.({
      workspaceMode,
      worktree,
    })
  } catch {
    return undefined
  }
}
