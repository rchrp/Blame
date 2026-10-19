import * as React from "react"

import { isKeyOwnedByTarget } from "@/lib/keyboard"

const composerInputSelector = "[data-markdown-editor-input='true']"

// Keyboard and quick-start helpers for the chat composer:
// "/" focuses it from anywhere on the page, and suggestions fill it.
export function useComposerShortcuts({
  draftRef,
  setDraft,
  setDraftEditorKey,
}: {
  draftRef: React.RefObject<HTMLDivElement | null>
  setDraft: (draft: string) => void
  setDraftEditorKey: React.Dispatch<React.SetStateAction<number>>
}) {
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isKeyOwnedByTarget(event.target)) return
      const input =
        draftRef.current?.querySelector<HTMLElement>(composerInputSelector)
      if (!input) return
      event.preventDefault()
      input.focus()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [draftRef])

  return React.useCallback(
    (prompt: string) => {
      setDraft(prompt)
      setDraftEditorKey((key) => key + 1)
      requestAnimationFrame(() => {
        draftRef.current
          ?.querySelector<HTMLElement>(composerInputSelector)
          ?.focus()
      })
    },
    [draftRef, setDraft, setDraftEditorKey]
  )
}
