import * as React from "react"
import {
  appendComposerDraftCodeSelections,
  composerDraftStorageKey,
} from "@/components/backlog/drawer/composer-draft-storage"
import type {
  CodeSelectionAttachment,
  PendingCodeSelectionAttachment,
} from "@/components/backlog/shared/comment-attachment-events"
import {
  subscribeToNewChatExcerpts,
  takeNewChatExcerpts,
} from "@/components/backlog/shared/excerpt-actions"
import { useLatestCallback } from "@/lib/use-latest-callback"

type ChatExcerptsInput = {
  addDraftCodeAttachments: (attachments: PendingCodeSelectionAttachment[]) => void
  hasActiveChat: boolean
  projectId?: string
  startNewChat: () => void
}

/**
 * Selected code or conversation text sent to the chat: "Attach as context"
 * adds it to the current draft, "Add to new chat" to the draft of a new
 * conversation. Returns the attach-as-context handler.
 */
export function useChatExcerpts({
  addDraftCodeAttachments,
  hasActiveChat,
  projectId,
  startNewChat,
}: ChatExcerptsInput) {
  const attachAsContext = React.useCallback(
    (excerpt: CodeSelectionAttachment) =>
      addDraftCodeAttachments([{ ...excerpt, id: crypto.randomUUID() }]),
    [addDraftCodeAttachments]
  )
  const openNewChatWithExcerpts = useLatestCallback(() => {
    const excerpts = takeNewChatExcerpts()
    if (excerpts.length === 0) return
    if (!hasActiveChat) {
      addDraftCodeAttachments(excerpts)
      return
    }
    appendComposerDraftCodeSelections(
      localStorage,
      composerDraftStorageKey(projectId ?? "project", "chat"),
      excerpts
    )
    startNewChat()
  })
  React.useEffect(() => {
    openNewChatWithExcerpts()
    return subscribeToNewChatExcerpts(openNewChatWithExcerpts)
  }, [openNewChatWithExcerpts])
  return attachAsContext
}
