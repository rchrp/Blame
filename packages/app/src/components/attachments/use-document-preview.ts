import { useEffect, useState } from "react"
import type { ComposerAttachment, DocumentPreview } from "./attachment-types"
import { documentPreview } from "./document-preview-data"

export function useDocumentPreview(
  attachment: ComposerAttachment,
  enabled = true
) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    file: File
    attempt: number
    data?: DocumentPreview
    error?: string
  }>()
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    documentPreview(attachment, attempt > 0).then(
      (data) => {
        if (!cancelled) setState({ file: attachment.file, attempt, data })
      },
      (error) => {
        if (!cancelled)
          setState({
            file: attachment.file,
            attempt,
            error:
              error instanceof Error ? error.message : "Preview unavailable",
          })
      }
    )
    return () => {
      cancelled = true
    }
  }, [attachment, enabled, attempt])
  const current =
    state?.file === attachment.file && state.attempt === attempt
      ? state
      : undefined
  return {
    data: current?.data,
    error: current?.error,
    retry: () => setAttempt((value) => value + 1),
  }
}
