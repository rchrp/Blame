import * as React from "react"

import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import {
  removeComposerDraft,
  writeComposerDraft,
} from "@/components/backlog/drawer/composer-draft-storage"
import {
  drawerComposerDraft,
  type PendingComposerDraft,
} from "@/components/backlog/drawer/user-story-drawer-parts"
import type { UserStoryDrawerMode } from "@/components/backlog/shared/backlog-types"
import type { PendingCodeSelectionAttachment } from "@/components/backlog/shared/comment-attachment-events"

const composerDraftPersistDelayMs = 500

// Keeps the drawer's unsent title, request or comment in local storage, so
// it survives closing the drawer.
export function useDrawerComposerDraft({
  comment,
  commentCodeSelectionAttachments,
  commentFileAttachments,
  draftStorageKey,
  mode,
  summary,
  summaryCodeSelectionAttachments,
  summaryFileAttachments,
  title,
  titleDraftKey,
}: {
  comment: string
  commentCodeSelectionAttachments: PendingCodeSelectionAttachment[]
  commentFileAttachments: UserStoryFileAttachment[]
  draftStorageKey: string
  mode: UserStoryDrawerMode
  summary: string
  summaryCodeSelectionAttachments: PendingCodeSelectionAttachment[]
  summaryFileAttachments: UserStoryFileAttachment[]
  title: string
  titleDraftKey: string
}) {
  const pendingComposerDraftRef = React.useRef<
    PendingComposerDraft | undefined
  >(undefined)
  const composerDraftRemovedRef = React.useRef(false)

  // A new story's title survives closing the drawer, like its description.
  React.useEffect(() => {
    if (mode !== "create") return
    const timer = window.setTimeout(() => {
      try {
        if (title.trim()) localStorage.setItem(titleDraftKey, title)
        else localStorage.removeItem(titleDraftKey)
      } catch {
        return
      }
    }, composerDraftPersistDelayMs)
    return () => window.clearTimeout(timer)
  }, [mode, title, titleDraftKey])

  React.useEffect(() => {
    const draft = drawerComposerDraft({
      comment,
      commentCodeSelectionAttachments,
      commentFileAttachments,
      mode,
      summary,
      summaryCodeSelectionAttachments,
      summaryFileAttachments,
    })
    pendingComposerDraftRef.current = { draft, key: draftStorageKey }
    composerDraftRemovedRef.current = false
    const timer = window.setTimeout(() => {
      writeComposerDraft(localStorage, draftStorageKey, draft)
    }, composerDraftPersistDelayMs)
    return () => window.clearTimeout(timer)
  }, [
    comment,
    commentCodeSelectionAttachments,
    commentFileAttachments,
    draftStorageKey,
    mode,
    summary,
    summaryCodeSelectionAttachments,
    summaryFileAttachments,
  ])

  React.useEffect(
    () => () => {
      const pending = pendingComposerDraftRef.current
      if (!pending || composerDraftRemovedRef.current) return
      writeComposerDraft(localStorage, pending.key, pending.draft)
    },
    []
  )

  function clearComposerDraft() {
    composerDraftRemovedRef.current = true
    removeComposerDraft(localStorage, draftStorageKey)
    try {
      localStorage.removeItem(titleDraftKey)
    } catch {
      return
    }
  }

  return { clearComposerDraft, pendingComposerDraftRef }
}

export function readTitleDraft(key: string) {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}
