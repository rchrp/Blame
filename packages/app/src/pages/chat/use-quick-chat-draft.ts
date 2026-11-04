import * as React from "react"
import {
  replaceFileAttachments,
  type FileAttachmentReplacement,
} from "@/components/backlog/drawer/user-story-attachment-files"
import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import type { PendingCodeSelectionAttachment } from "@/components/backlog/shared/comment-attachment-events"
import {
  readComposerDraft,
  removeComposerDraft,
  writeComposerDraft,
} from "@/components/backlog/drawer/composer-draft-storage"

export function useQuickChatDraft(storageKey: string) {
  const [draft, setDraft] = React.useState("")
  const [draftEditorKey, setDraftEditorKey] = React.useState(0)
  const [draftCodeAttachments, setDraftCodeAttachments] = React.useState<
    PendingCodeSelectionAttachment[]
  >([])
  const [draftFileAttachments, setDraftFileAttachments] = React.useState<
    UserStoryFileAttachment[]
  >([])
  const draftRef = React.useRef<HTMLDivElement>(null)
  const loadedDraftStorageKeyRef = React.useRef<string | undefined>(undefined)

  React.useEffect(() => {
    if (loadedDraftStorageKeyRef.current !== storageKey) {
      loadedDraftStorageKeyRef.current = storageKey
      const storedDraft = readComposerDraft(localStorage, storageKey)
      setDraft(storedDraft?.markdown ?? "")
      setDraftCodeAttachments(storedDraft?.codeSelectionAttachments ?? [])
      setDraftFileAttachments(storedDraft?.fileAttachments ?? [])
      setDraftEditorKey((key) => key + 1)
      return
    }
    writeComposerDraft(localStorage, storageKey, {
      markdown: draft,
      codeSelectionAttachments: draftCodeAttachments,
      fileAttachments: draftFileAttachments,
    })
  }, [draft, draftCodeAttachments, draftFileAttachments, storageKey])

  const addDraftCodeAttachments = React.useCallback(
    (attachments: PendingCodeSelectionAttachment[]) => {
      setDraftCodeAttachments((current) => [...current, ...attachments])
      requestAnimationFrame(() => {
        draftRef.current
          ?.querySelector<HTMLElement>("[data-markdown-editor-input='true']")
          ?.focus()
      })
    },
    []
  )

  const addDraftFileAttachments = React.useCallback(
    (attachments: UserStoryFileAttachment[]) => {
      setDraftFileAttachments((current) => [...current, ...attachments])
    },
    []
  )
  const removeDraftFileAttachment = React.useCallback((id: string) => {
    setDraftFileAttachments((current) =>
      current.filter((attachment) => attachment.id !== id)
    )
  }, [])
  const replaceDraftFileAttachments = React.useCallback(
    (replacements: FileAttachmentReplacement[]) => {
      setDraftFileAttachments((current) =>
        replaceFileAttachments(current, replacements)
      )
    },
    []
  )

  function draftHasContent() {
    return Boolean(
      draft.trim() || draftCodeAttachments.length || draftFileAttachments.length
    )
  }

  function clearDraft() {
    removeComposerDraft(localStorage, storageKey)
    setDraft("")
    setDraftCodeAttachments([])
    setDraftFileAttachments([])
    setDraftEditorKey((key) => key + 1)
  }

  return {
    addDraftCodeAttachments,
    addDraftFileAttachments,
    removeDraftFileAttachment,
    replaceDraftFileAttachments,
    clearDraft,
    draft,
    draftCodeAttachments,
    draftEditorKey,
    draftFileAttachments,
    draftHasContent,
    draftRef,
    setDraft,
    setDraftCodeAttachments,
    setDraftEditorKey,
    setDraftFileAttachments,
  }
}
