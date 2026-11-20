// A quick chat as the API keeps it: product state only. Its conversation is
// its engine session's records, which the engine keeps and copies to the
// API itself (docs/engine-in-the-app.md).

export const quickChatSelectedEvent = "quick-chat:selected"

export type QuickChat = {
  createdAt: string
  /** The engine session holding the conversation. */
  engineSessionId: string | null
  id: string
  /** The later of the chat's own change and its conversation's last record. */
  lastActivityAt?: string | null
  projectId: string
  title: string
  updatedAt?: string | null
  workspace?: string | null
}

export type QuickChatDraft = {
  engineSessionId: string
  projectId: string
  title: string
  workspace?: string | null
}

export type QuickChatUpdate = Partial<Pick<QuickChat, "title" | "workspace">>
