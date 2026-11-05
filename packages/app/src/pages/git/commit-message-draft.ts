import * as React from "react"

// The commit message written for a repository, and whether the agent is
// writing one, kept for the whole app: leaving the Git page while the agent
// writes it no longer loses the message.
const drafts = new Map<string, string>()
const generating = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function emit() {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setCommitMessageDraft(root: string, message: string) {
  if ((drafts.get(root) ?? "") === message) return
  if (message) drafts.set(root, message)
  else drafts.delete(root)
  emit()
}

// Marks the repository's message as being written until `task` settles.
export async function generateCommitMessageDraft<T>(
  root: string,
  task: () => Promise<T>
) {
  generating.add(root)
  emit()
  try {
    return await task()
  } finally {
    generating.delete(root)
    emit()
  }
}

export function useCommitMessageDraft(root: string | undefined) {
  React.useSyncExternalStore(
    subscribe,
    () => version,
    () => version
  )
  const setMessage = React.useCallback(
    (message: string) => {
      if (root) setCommitMessageDraft(root, message)
    },
    [root]
  )
  return {
    generating: Boolean(root && generating.has(root)),
    message: (root && drafts.get(root)) || "",
    setMessage,
  }
}
