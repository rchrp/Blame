import * as React from "react"

import type {
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"

// Comments written while a story's agent is working. They wait here and go
// out together when the agent finishes its turn, or right away when the
// person chooses "Send now" (the agent stops, reads them, and carries on).
// Kept in local storage so a restart does not lose them.

export type QueuedComment = {
  body: string
  codeSelectionAttachments: UserStoryCodeSelectionAttachment[]
  createdAt: string
  fileAttachments: UserStoryFileAttachment[]
  id: string
  storyId: string
}

const storageKey = "blame.comment-queue.v1"
const listeners = new Set<() => void>()
const deliveryListeners = new Set<
  (storyId: string, commentId: string) => void
>()
let queue: QueuedComment[] = readQueue()

function readQueue(): QueuedComment[] {
  try {
    const value: unknown = JSON.parse(
      globalThis.localStorage?.getItem(storageKey) ?? "[]"
    )
    return Array.isArray(value) ? (value as QueuedComment[]) : []
  } catch {
    return []
  }
}

function save(next: QueuedComment[]) {
  queue = next
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(next))
  } catch {
    // Still delivered while the app stays open.
  }
  for (const listener of listeners) listener()
}

export function queueComment(
  comment: Omit<QueuedComment, "createdAt" | "id">
): QueuedComment {
  const queued = {
    ...comment,
    createdAt: new Date().toISOString(),
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
  }
  save([...queue, queued])
  return queued
}

export function removeQueuedComment(id: string) {
  save(queue.filter((comment) => comment.id !== id))
}

export function queuedComments(storyId: string) {
  return queue.filter((comment) => comment.storyId === storyId)
}

export function storiesWithQueuedComments() {
  return [...new Set(queue.map((comment) => comment.storyId))]
}

// Removes and returns a story's queued comments (or just one of them),
// merged into one message.
export function takeQueuedComments(storyId: string, commentId?: string) {
  const taken = queuedComments(storyId).filter(
    (comment) => !commentId || comment.id === commentId
  )
  if (!taken.length) return undefined
  const ids = new Set(taken.map((comment) => comment.id))
  save(queue.filter((comment) => !ids.has(comment.id)))
  return mergeQueuedComments(taken)
}

export function dropQueuedComments(storyId: string) {
  if (queuedComments(storyId).length)
    save(queue.filter((comment) => comment.storyId !== storyId))
}

export function mergeQueuedComments(comments: QueuedComment[]) {
  return {
    body: comments.map((comment) => comment.body.trim()).filter(Boolean).join("\n\n"),
    codeSelectionAttachments: comments.flatMap(
      (comment) => comment.codeSelectionAttachments
    ),
    fileAttachments: comments.flatMap((comment) => comment.fileAttachments),
  }
}

// "Send now" on one queued comment: asks whoever delivers comments to send
// it immediately. The others stay queued.
export function requestQueuedDelivery(storyId: string, commentId: string) {
  for (const listener of deliveryListeners) listener(storyId, commentId)
}

export function onQueuedDeliveryRequest(
  listener: (storyId: string, commentId: string) => void
) {
  deliveryListeners.add(listener)
  return () => {
    deliveryListeners.delete(listener)
  }
}

export function useQueuedComments(storyId: string | undefined) {
  const snapshot = React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => queue,
    () => queue
  )
  return React.useMemo(
    () => (storyId ? snapshot.filter((comment) => comment.storyId === storyId) : []),
    [snapshot, storyId]
  )
}
