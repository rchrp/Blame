import * as React from "react"

// A short notice in the preview toolbar when new content reaches the
// preview, so people can tell that what they see now includes the agent's
// latest changes.

const noticeMilliseconds = 4000

export type PreviewUpdateSignal = {
  syncSequence?: number
  changedFiles?: number
  agentRunning: boolean
}

export function previewUpdateMessage(
  previous: PreviewUpdateSignal,
  current: PreviewUpdateSignal
) {
  if (
    current.syncSequence !== undefined &&
    previous.syncSequence !== undefined &&
    current.syncSequence > previous.syncSequence
  ) {
    const files = current.changedFiles
    if (files === undefined) return "Preview updated"
    return files === 1 ? "1 file updated" : `${files} files updated`
  }
  if (
    current.syncSequence === undefined &&
    previous.agentRunning &&
    !current.agentRunning
  ) {
    return "Agent changes applied"
  }
  return undefined
}

export function usePreviewUpdateNotice(signal: PreviewUpdateSignal) {
  const { syncSequence, changedFiles, agentRunning } = signal
  const previous = React.useRef<PreviewUpdateSignal>(signal)
  const [notice, setNotice] = React.useState<{ id: number; message: string }>()
  React.useEffect(() => {
    const current = { syncSequence, changedFiles, agentRunning }
    const message = previewUpdateMessage(previous.current, current)
    previous.current = current
    if (!message) return
    const id = Date.now()
    const show = window.setTimeout(() => setNotice({ id, message }), 0)
    const hide = window.setTimeout(
      () => setNotice((value) => (value?.id === id ? undefined : value)),
      noticeMilliseconds
    )
    return () => {
      window.clearTimeout(show)
      window.clearTimeout(hide)
    }
  }, [agentRunning, changedFiles, syncSequence])
  return notice?.message
}
