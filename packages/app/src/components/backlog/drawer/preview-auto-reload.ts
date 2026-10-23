import * as React from "react"

import { usePlatform } from "@/context/platform"
import { previewHotReloads } from "./preview-hot-reload"

// Apps without a hot reload client keep showing the old page after the
// agent changes their files, so the preview reloads itself once changes
// land: after a cloud sync, or when the agent's run ends for previews that
// see the worktree directly. The delay lets a server framework restart.

const reloadDelayMilliseconds = 2000
const manifestPath = ".blame/initialization/preview-manifest.json"

export function usePreviewHotReloads(worktree: string | undefined) {
  const workspace = usePlatform().workspace
  const [entry, setEntry] = React.useState<{
    worktree: string
    hotReloads?: boolean
  }>()
  React.useEffect(() => {
    if (!worktree || !workspace) return
    let active = true
    void workspace
      .readFile({ root: worktree, path: manifestPath })
      .then((text) => {
        const stack = (
          JSON.parse(text) as { project?: { detectedStack?: unknown } }
        ).project?.detectedStack
        const names = Array.isArray(stack)
          ? stack.filter((name): name is string => typeof name === "string")
          : undefined
        if (active) setEntry({ worktree, hotReloads: previewHotReloads(names) })
      })
      .catch(() => {
        if (active) setEntry({ worktree })
      })
    return () => {
      active = false
    }
  }, [workspace, worktree])
  return entry && entry.worktree === worktree ? entry.hotReloads : undefined
}

export function useReloadAfterChanges(input: {
  enabled: boolean
  syncSequence?: number
  agentRunning: boolean
  setReloadKey: React.Dispatch<React.SetStateAction<number>>
}) {
  const { enabled, syncSequence, agentRunning, setReloadKey } = input
  const previous = React.useRef({ syncSequence, agentRunning })
  React.useEffect(() => {
    const before = previous.current
    previous.current = { syncSequence, agentRunning }
    if (!enabled) return
    const synced =
      syncSequence !== undefined &&
      before.syncSequence !== undefined &&
      syncSequence > before.syncSequence
    const agentFinished = before.agentRunning && !agentRunning
    if (!synced && !agentFinished) return
    const timer = window.setTimeout(
      () => setReloadKey((current) => current + 1),
      reloadDelayMilliseconds
    )
    return () => window.clearTimeout(timer)
  }, [agentRunning, enabled, setReloadKey, syncSequence])
}
