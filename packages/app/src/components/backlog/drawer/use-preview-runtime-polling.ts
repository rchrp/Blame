import type { ProjectPreviewRuntimeState } from "@blame/agent-runtime"
import * as React from "react"

import {
  previewRuntimePollDelay,
  samePreviewRuntimeState,
  samePreviewWorktree,
} from "@/components/backlog/drawer/preview-runtime-poll"
import { usePlatform } from "@/context/platform"

type PreviewRuntimeSetter = React.Dispatch<
  React.SetStateAction<ProjectPreviewRuntimeState | undefined>
>

// Keeps a story's local preview state current while its preview shows:
// read again when the desktop changes it, polled for what only Docker
// sees, and not at all while the window is hidden.
export function usePreviewRuntimePolling(
  workspace: ReturnType<typeof usePlatform>["workspace"],
  worktree: string | null | undefined,
  enabled: boolean,
  workspaceMode: "local-container" | "cloud-mirror",
  stopAfterConfigured: boolean,
  configuredCount: number | undefined,
  setRuntime: PreviewRuntimeSetter
) {
  React.useEffect(() => {
    setRuntime(undefined)
  }, [enabled, setRuntime, workspace, workspaceMode, worktree])

  React.useEffect(() => {
    if (!enabled || !worktree || !workspace?.projectPreviewRuntimeState) return
    const polling = !(stopAfterConfigured && configuredCount)
    let cancelled = false
    let reading = false
    let readAgain = false
    let timer: number | undefined
    let latest: ProjectPreviewRuntimeState | undefined
    // One read at a time; a change during a read is read once it answers.
    const refresh = () => {
      if (reading) {
        readAgain = true
        return
      }
      reading = true
      readAgain = false
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
          if (readAgain) return refresh()
          if (!polling) return
          const delay = previewRuntimePollDelay({
            hidden: document.visibilityState === "hidden",
            runtime: latest,
          })
          if (delay !== undefined) timer = window.setTimeout(refresh, delay)
        }
      )
    }
    const refreshWhenShown = () => {
      if (document.visibilityState === "hidden") window.clearTimeout(timer)
      else refresh()
    }
    const stopListening = workspace.onProjectPreviewRuntimeChanged?.(
      (change) => {
        if (samePreviewWorktree(change.worktree, worktree)) refresh()
      }
    )
    refresh()
    document.addEventListener("visibilitychange", refreshWhenShown)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      stopListening?.()
      document.removeEventListener("visibilitychange", refreshWhenShown)
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
}

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
