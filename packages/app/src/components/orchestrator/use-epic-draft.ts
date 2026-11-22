import { composerDraftStorageKey } from "@/components/backlog/drawer/composer-draft-storage"
import { pendingFileAttachments } from "@/components/backlog/drawer/user-story-attachment-files"
import { useComposerShortcuts } from "@/pages/chat/use-composer-shortcuts"
import { useQuickChatDraft } from "@/pages/chat/use-quick-chat-draft"

export function useEpicDraft(projectId: string, epicId?: string) {
  const key = composerDraftStorageKey(projectId, "epic", epicId)
  const draft = useQuickChatDraft(key)
  const applySuggestion = useComposerShortcuts(draft)
  return {
    applySuggestion,
    clear: draft.clearDraft,
    message: {
      text: draft.draft.trim(),
      codeSelectionAttachments: draft.draftCodeAttachments,
      fileAttachments: draft.draftFileAttachments,
    },
    composer: {
      message: draft.draft,
      editorRef: draft.draftRef,
      editorKey: draft.draftEditorKey,
      codeSelectionAttachments: draft.draftCodeAttachments,
      fileAttachments: pendingFileAttachments(draft.draftFileAttachments),
      onMessageChange: draft.setDraft,
      onFileAttachmentsAdd: draft.addDraftFileAttachments,
      onFileAttachmentRemove: draft.removeDraftFileAttachment,
      onFileAttachmentsReplace: draft.replaceDraftFileAttachments,
      onCodeSelectionAttachmentRemove: (id: string) =>
        draft.setDraftCodeAttachments((current) =>
          current.filter((attachment) => attachment.id !== id)
        ),
      speechSessionKey: key,
      speechTarget: {
        draftKey: key,
        label: epicId ? "your message to the orchestrator" : "your epic goal",
      },
    },
  }
}
