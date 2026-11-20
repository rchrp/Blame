import type { AgentPersistenceEvent } from "./backlog-data.ts"

const storageKey = "blame:agent-snapshot-outbox:v1"

export type AgentSnapshotTarget = "user-story"

export type DurableAgentSnapshot<T> = {
  event: AgentPersistenceEvent
  messageId: string
  projectId: string
  runId: string
  targetId: string
  targetType: AgentSnapshotTarget
  update: T
}

export async function persistAgentSnapshot<T, Result>(
  storage: Storage,
  snapshot: DurableAgentSnapshot<T>,
  persist: (snapshot: DurableAgentSnapshot<T>) => Promise<Result>
) {
  enqueueAgentSnapshot(storage, snapshot)
  const result = await persist(snapshot)
  acknowledgeAgentSnapshot(storage, snapshot)
  return result
}

export function pendingAgentSnapshots(
  storage: Storage,
  projectId: string,
  targetType?: AgentSnapshotTarget
) {
  return readAgentSnapshots(storage).filter(
    (snapshot) =>
      snapshot.projectId === projectId &&
      (!targetType || snapshot.targetType === targetType)
  )
}

export function pendingAgentRunSnapshots(
  storage: Storage,
  projectId: string,
  targetType: AgentSnapshotTarget,
  runId: string
) {
  return pendingAgentSnapshots(storage, projectId, targetType).filter(
    (snapshot) => snapshot.runId === runId
  )
}

export function acknowledgeAgentSnapshot(
  storage: Storage,
  completed: Pick<DurableAgentSnapshot<unknown>, "event" | "runId">
) {
  const snapshots = readAgentSnapshots(storage)
  writeAgentSnapshots(
    storage,
    snapshots.filter((snapshot) => !sameSnapshot(snapshot, completed))
  )
}

export async function replayAgentSnapshots(
  storage: Storage,
  projectId: string,
  targetType: AgentSnapshotTarget,
  persist: (snapshot: DurableAgentSnapshot<unknown>) => Promise<unknown>
) {
  const snapshots = pendingAgentSnapshots(storage, projectId, targetType).sort(
    (left, right) => left.event.sequenceNumber - right.event.sequenceNumber
  )
  for (const snapshot of snapshots) {
    await persistAgentSnapshot(storage, snapshot, persist)
  }
}

function enqueueAgentSnapshot<T>(
  storage: Storage,
  snapshot: DurableAgentSnapshot<T>
) {
  const snapshots = readAgentSnapshots(storage).filter(
    (current) => snapshotKey(current) !== snapshotKey(snapshot)
  )
  writeAgentSnapshots(storage, [...snapshots, snapshot])
}

function snapshotKey(snapshot: DurableAgentSnapshot<unknown>) {
  return `${snapshot.targetType}:${snapshot.targetId}:${snapshot.runId}:${snapshot.messageId}`
}

function sameSnapshot(
  snapshot: DurableAgentSnapshot<unknown>,
  completed: Pick<DurableAgentSnapshot<unknown>, "event" | "runId">
) {
  return (
    snapshot.runId === completed.runId &&
    snapshot.event.eventId === completed.event.eventId &&
    snapshot.event.sequenceNumber === completed.event.sequenceNumber
  )
}

function readAgentSnapshots(storage: Storage): DurableAgentSnapshot<unknown>[] {
  try {
    const value = JSON.parse(storage.getItem(storageKey) ?? "[]")
    return Array.isArray(value) ? value.filter(durableAgentSnapshot) : []
  } catch {
    return []
  }
}

function writeAgentSnapshots(
  storage: Storage,
  snapshots: DurableAgentSnapshot<unknown>[]
) {
  storage.setItem(storageKey, JSON.stringify(snapshots))
}

function durableAgentSnapshot(
  value: unknown
): value is DurableAgentSnapshot<unknown> {
  if (!value || typeof value !== "object") return false
  const snapshot = value as Partial<DurableAgentSnapshot<unknown>>
  return (
    Boolean(snapshot.event) &&
    typeof snapshot.messageId === "string" &&
    typeof snapshot.projectId === "string" &&
    typeof snapshot.runId === "string" &&
    typeof snapshot.targetId === "string" &&
    snapshot.targetType === "user-story" &&
    snapshot.update !== undefined
  )
}
