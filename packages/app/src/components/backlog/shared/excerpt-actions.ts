import type {
  CodeSelectionAttachment,
  PendingCodeSelectionAttachment,
} from "@/components/backlog/shared/comment-attachment-events"
import { createExcerptQueue } from "@/components/backlog/shared/excerpt-model"
import {
  navigate,
  navigationPathname,
} from "@/components/navigation/navigation"

const newUserStoryExcerptEvent = "blame:new-user-story-excerpt"
const newChatExcerptEvent = "blame:new-chat-excerpt"

const newUserStoryExcerpts =
  createExcerptQueue<PendingCodeSelectionAttachment>()
const newChatExcerpts = createExcerptQueue<PendingCodeSelectionAttachment>()

// Opens a new user story holding the excerpt, from any page.
export function startUserStoryWithExcerpt(excerpt: CodeSelectionAttachment) {
  newUserStoryExcerpts.push(pendingExcerpt(excerpt))
  openPage("/backlog", newUserStoryExcerptEvent)
}

// Opens a new chat holding the excerpt, from any page.
export function startChatWithExcerpt(excerpt: CodeSelectionAttachment) {
  newChatExcerpts.push(pendingExcerpt(excerpt))
  openPage("/chat", newChatExcerptEvent)
}

export function takeNewUserStoryExcerpts() {
  return newUserStoryExcerpts.take()
}

export function takeNewChatExcerpts() {
  return newChatExcerpts.take()
}

export function subscribeToNewUserStoryExcerpts(callback: () => void) {
  window.addEventListener(newUserStoryExcerptEvent, callback)
  return () => window.removeEventListener(newUserStoryExcerptEvent, callback)
}

export function subscribeToNewChatExcerpts(callback: () => void) {
  window.addEventListener(newChatExcerptEvent, callback)
  return () => window.removeEventListener(newChatExcerptEvent, callback)
}

// A page already open takes the excerpt on the event; a page that opens
// takes it when it mounts.
function openPage(pathname: string, eventName: string) {
  if (navigationPathname() !== pathname) navigate(pathname)
  window.dispatchEvent(new Event(eventName))
}

function pendingExcerpt(
  excerpt: CodeSelectionAttachment
): PendingCodeSelectionAttachment {
  return { ...excerpt, id: crypto.randomUUID() }
}
