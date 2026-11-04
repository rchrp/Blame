import type { BacklogColumnId } from "../data/backlog-data.ts"
import {
  codeSelectionLineLabel,
  type CodeSelectionAttachment,
} from "./comment-attachment-events.ts"

// What can be done with text selected in code or in a conversation.
export type ExcerptAction = "attach-as-context" | "new-user-story" | "new-chat"

export type MessageAuthor = "agent" | "user"

export const excerptActionLabels: Record<ExcerptAction, string> = {
  "attach-as-context": "Attach as context",
  "new-user-story": "Add to new user story",
  "new-chat": "Add to new chat",
}

const messageExcerptTitles: Record<MessageAuthor, string> = {
  agent: "Agent message",
  user: "User message",
}

// Done and discarded stories take no more input.
export function storyAcceptsExcerpts(status: BacklogColumnId) {
  return status !== "done" && status !== "discarded"
}

export function excerptActions(canAttachAsContext: boolean): ExcerptAction[] {
  return canAttachAsContext
    ? ["attach-as-context", "new-user-story", "new-chat"]
    : ["new-user-story", "new-chat"]
}

export function codeExcerpt({
  lineNumbers,
  path,
  text,
}: {
  lineNumbers: number[]
  path: string
  text: string
}): CodeSelectionAttachment | undefined {
  const content = excerptContent(text)
  const lines = lineNumbers.filter((line) => Number.isInteger(line) && line > 0)
  if (!content || !path || lines.length === 0) return undefined
  return {
    content,
    endLine: lines.reduce((last, line) => Math.max(last, line)),
    path,
    startLine: lines.reduce((first, line) => Math.min(first, line)),
  }
}

// Lines count within the excerpt itself: a message has no file to point at.
export function messageExcerpt({
  author,
  text,
}: {
  author: MessageAuthor
  text: string
}): CodeSelectionAttachment | undefined {
  const content = excerptContent(text)
  if (!content) return undefined
  return {
    content,
    endLine: content.split("\n").length,
    origin: "message",
    path: messageExcerptTitles[author],
    startLine: 1,
  }
}

export function excerptCard(attachment: CodeSelectionAttachment) {
  if (attachment.origin === "message") {
    return {
      fileName: `${attachment.path.toLowerCase().replace(/\s+/g, "-")}.md`,
      mimeType: "text/markdown",
      subtitle: undefined,
      title: attachment.path,
    }
  }
  return {
    fileName: attachment.path,
    mimeType: "text/plain",
    subtitle: codeSelectionLineLabel(attachment),
    title: attachment.path,
  }
}

// Excerpts waiting for the view that opens them, read once.
export function createExcerptQueue<Excerpt>() {
  let pending: Excerpt[] = []
  return {
    push(excerpt: Excerpt) {
      pending = [...pending, excerpt]
    },
    take() {
      const taken = pending
      pending = []
      return taken
    },
  }
}

// The selection keeps its inner layout and indentation; only the blank
// lines around it go.
function excerptContent(text: string) {
  const content = text
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "")
  return content.trim() ? content : undefined
}
