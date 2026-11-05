import type { PreviewSessionView } from "@blame/preview-runtime"

import type { ProjectRunnerPendingOperation } from "@/components/backlog/board/project-runner-types"

type SessionListener = (session: PreviewSessionView | undefined) => void
type PendingOperationListener = (
  operation: ProjectRunnerPendingOperation | undefined
) => void

const sessions = new Map<string, PreviewSessionView>()
const listeners = new Map<string, Set<SessionListener>>()
const pendingOperations = new Map<string, ProjectRunnerPendingOperation>()
const pendingOperationListeners = new Map<
  string,
  Set<PendingOperationListener>
>()
const controlOperations = new Map<string, Promise<void>>()

export type CloudPreviewControlLease =
  | { acquired: false; completed: Promise<void> }
  | { acquired: true; completed: Promise<void>; release: () => void }

export function beginCloudPreviewControl(
  userStoryId: string
): CloudPreviewControlLease {
  const active = controlOperations.get(userStoryId)
  if (active) return { acquired: false, completed: active }
  let settle!: () => void
  const completed = new Promise<void>((resolve) => {
    settle = resolve
  })
  let released = false
  const release = () => {
    if (released) return
    released = true
    settle()
    if (controlOperations.get(userStoryId) === completed) {
      controlOperations.delete(userStoryId)
    }
  }
  controlOperations.set(userStoryId, completed)
  return { acquired: true, completed, release }
}

export function activeCloudPreviewControl(userStoryId: string) {
  return controlOperations.get(userStoryId)
}

export async function acquireCloudPreviewControl(userStoryId: string) {
  while (true) {
    const lease = beginCloudPreviewControl(userStoryId)
    if (lease.acquired) return lease
    await lease.completed
  }
}

export function cloudPreviewSessionStorageId(
  userStoryId: string,
  profile: string
) {
  return `blame.preview-session.${profile}.${userStoryId}`
}

export function cachedCloudPreviewSession(storageId: string | undefined) {
  return storageId ? sessions.get(storageId) : undefined
}

export function publishCloudPreviewSession(
  storage: Pick<Storage, "setItem">,
  storageId: string,
  session: PreviewSessionView
) {
  const previous = sessions.get(storageId)
  const current = mergeCloudPreviewUsage(previous, session)
  // A poll that brings nothing new keeps the session its listeners have.
  if (previous && JSON.stringify(previous) === JSON.stringify(current)) {
    return previous
  }
  sessions.set(storageId, current)
  if (previous?.id !== current.id) storage.setItem(storageId, current.id)
  listeners.get(storageId)?.forEach((listener) => listener(current))
  return current
}

export function clearCloudPreviewSession(
  storage: Pick<Storage, "removeItem">,
  storageId: string
) {
  sessions.delete(storageId)
  pendingOperations.delete(storageId)
  storage.removeItem(storageId)
  listeners.get(storageId)?.forEach((listener) => listener(undefined))
  pendingOperationListeners
    .get(storageId)
    ?.forEach((listener) => listener(undefined))
}

export function subscribeCloudPreviewSession(
  storageId: string,
  listener: SessionListener
) {
  const current = listeners.get(storageId) ?? new Set<SessionListener>()
  current.add(listener)
  listeners.set(storageId, current)
  return () => {
    current.delete(listener)
    if (!current.size) {
      listeners.delete(storageId)
      sessions.delete(storageId)
    }
  }
}

export function cachedCloudPreviewPendingOperation(
  storageId: string | undefined
) {
  return storageId ? pendingOperations.get(storageId) : undefined
}

export function publishCloudPreviewPendingOperation(
  storageId: string,
  operation: ProjectRunnerPendingOperation | undefined
) {
  if (operation) pendingOperations.set(storageId, operation)
  else pendingOperations.delete(storageId)
  pendingOperationListeners
    .get(storageId)
    ?.forEach((listener) => listener(operation))
}

export function subscribeCloudPreviewPendingOperation(
  storageId: string,
  listener: PendingOperationListener
) {
  const current =
    pendingOperationListeners.get(storageId) ??
    new Set<PendingOperationListener>()
  current.add(listener)
  pendingOperationListeners.set(storageId, current)
  return () => {
    current.delete(listener)
    if (!current.size) pendingOperationListeners.delete(storageId)
  }
}

function mergeCloudPreviewUsage(
  previous: PreviewSessionView | undefined,
  current: PreviewSessionView
) {
  if (previous?.id !== current.id || !previous.usage || !current.usage) {
    return current
  }
  const previousObservedAt = Date.parse(previous.usage.observedAt)
  const currentObservedAt = Date.parse(current.usage.observedAt)
  const observedAt = Math.max(previousObservedAt, currentObservedAt)
  const elapsedSeconds =
    previous.state.host === "running" &&
    current.state.host === "running" &&
    Number.isFinite(previousObservedAt) &&
    Number.isFinite(currentObservedAt) &&
    currentObservedAt > previousObservedAt
      ? Math.floor((currentObservedAt - previousObservedAt) / 1000)
      : 0
  const activeSeconds = Math.max(
    current.usage.activeSeconds,
    previous.usage.activeSeconds + elapsedSeconds
  )
  const estimatedCostUsd = Math.max(
    current.usage.estimatedCostUsd,
    previous.usage.estimatedCostUsd
  )
  if (
    activeSeconds === current.usage.activeSeconds &&
    estimatedCostUsd === current.usage.estimatedCostUsd &&
    observedAt === currentObservedAt
  ) {
    return current
  }
  return {
    ...current,
    usage: {
      activeSeconds,
      estimatedCostUsd,
      observedAt: Number.isFinite(observedAt)
        ? new Date(observedAt).toISOString()
        : current.usage.observedAt,
    },
  }
}
