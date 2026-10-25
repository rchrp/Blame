import type {
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import {
  isFileAttachmentReference,
  originalFileAttachment,
} from "../../../lib/file-attachment-api.ts"

export type ComposerDraft = {
  codeSelectionAttachments: UserStoryCodeSelectionAttachment[]
  fileAttachments: UserStoryFileAttachment[]
  markdown: string
}

export function composerDraftStorageKey(
  projectId: string,
  kind: "backlog" | "chat",
  targetId?: string
) {
  return `blame.app.composer-draft.v1:${projectId}:${kind}:${targetId ?? "new"}`
}

export function readComposerDraft(
  storage: Pick<Storage, "getItem">,
  key: string
): ComposerDraft | undefined {
  try {
    const value = storage.getItem(key)
    if (!value) return undefined
    const parsed: unknown = JSON.parse(value)
    return isComposerDraft(parsed)
      ? {
          ...parsed,
          fileAttachments: parsed.fileAttachments.map(originalFileAttachment),
        }
      : undefined
  } catch {
    return undefined
  }
}

export function writeComposerDraft(
  storage: Pick<Storage, "removeItem" | "setItem">,
  key: string,
  draft: ComposerDraft
) {
  if (
    !draft.markdown &&
    draft.codeSelectionAttachments.length === 0 &&
    draft.fileAttachments.length === 0
  ) {
    storage.removeItem(key)
    return
  }
  storage.setItem(
    key,
    JSON.stringify({
      ...draft,
      fileAttachments: draft.fileAttachments.map(originalFileAttachment),
    })
  )
}

// A dictation finished while its editor was closed lands in the draft.
export function appendComposerDraftText(
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem">,
  key: string,
  text: string
) {
  const draft = readComposerDraft(storage, key) ?? {
    codeSelectionAttachments: [],
    fileAttachments: [],
    markdown: "",
  }
  const separator = !draft.markdown || /\s$/.test(draft.markdown) ? "" : " "
  writeComposerDraft(storage, key, {
    ...draft,
    markdown: `${draft.markdown}${separator}${text.trim()}`,
  })
}

export function removeComposerDraft(
  storage: Pick<Storage, "removeItem">,
  key: string
) {
  storage.removeItem(key)
}

function isComposerDraft(value: unknown): value is ComposerDraft {
  if (!value || typeof value !== "object") return false
  const draft = value as Record<string, unknown>
  return (
    typeof draft.markdown === "string" &&
    Array.isArray(draft.codeSelectionAttachments) &&
    draft.codeSelectionAttachments.every(isCodeSelectionAttachment) &&
    Array.isArray(draft.fileAttachments) &&
    draft.fileAttachments.every(isFileAttachment)
  )
}

function isCodeSelectionAttachment(value: unknown) {
  if (!value || typeof value !== "object") return false
  const attachment = value as Record<string, unknown>
  return (
    typeof attachment.id === "string" &&
    typeof attachment.content === "string" &&
    typeof attachment.path === "string" &&
    typeof attachment.startLine === "number" &&
    typeof attachment.endLine === "number"
  )
}

function isFileAttachment(value: unknown) {
  return isFileAttachmentReference(value)
}
