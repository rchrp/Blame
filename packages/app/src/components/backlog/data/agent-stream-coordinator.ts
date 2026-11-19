import type { AgentEvent } from "@blame/agent-runtime"
import type { AgentPersistenceEvent } from "./backlog-data.ts"

import {
  agentFlowUpdate,
  terminalAgentRunEvent,
  type AgentFlowState,
  type AgentFlowUpdate,
} from "./agent-flow.ts"
import {
  agentStreamStore,
  type AgentStreamIdentity,
  type AgentStreamStore,
} from "./agent-stream-store.ts"
import { mergeAgentActivities } from "./agent-activity-merge.ts"

export type AgentStreamSnapshotPersistence = {
  event: AgentEvent
  persistenceEvent: AgentPersistenceEvent
  update: AgentFlowUpdate
}

type AgentStreamCoordinatorInput = AgentStreamIdentity & {
  executionId: string
  initialState: AgentFlowState
  lastSequenceNumber?: number | null
  onError?: (error: unknown) => void
  persist(snapshot: AgentStreamSnapshotPersistence): Promise<unknown> | unknown
  recoveredSnapshots?: RecoveredAgentSnapshot[]
  store?: AgentStreamStore
}

type RecoveredAgentSnapshot = {
  event: AgentPersistenceEvent
  update: unknown
}

type PendingSnapshot = AgentStreamSnapshotPersistence & {
  activityId?: string
  bytes: number
}

type AgentPersistenceIdentity = {
  executionId: string
  lastSequenceNumber?: number | null
  runId: string
  sessionId: string
}

const snapshotIntervalMs = 750
const snapshotByteThreshold = 3 * 1024

export class AgentStreamCoordinator {
  private readonly input: AgentStreamCoordinatorInput
  private state: AgentFlowState
  private pending?: PendingSnapshot
  private timer?: ReturnType<typeof setTimeout>
  private persistence = Promise.resolve<unknown>(undefined)
  private sequenceNumber = 0
  private handledSequenceNumber = 0
  private readonly seenEventIds = new Set<string>()
  private readonly identity: AgentStreamIdentity
  private readonly store: AgentStreamStore
  private terminalSnapshot?: AgentStreamSnapshotPersistence
  private termination?: Promise<unknown>

  constructor(input: AgentStreamCoordinatorInput) {
    this.input = input
    this.identity = { runId: input.runId, sessionId: input.sessionId }
    this.state = input.initialState
    this.store = input.store ?? agentStreamStore
    this.sequenceNumber = input.lastSequenceNumber ?? 0
    this.handledSequenceNumber = input.lastSequenceNumber ?? 0
    this.store.seed(
      this.identity,
      input.initialState.agentActivities ?? [],
      this.sequenceNumber
    )
    this.recoverSnapshots(input.recoveredSnapshots ?? [])
  }

  push(event: AgentEvent): Promise<unknown> {
    if (terminalAgentRunEvent(event)) return this.terminate(event)
    if (this.terminalSnapshot) return this.termination ?? this.persistence
    const snapshot = this.createSnapshot(event)
    if (!snapshot) return this.persistence
    const activity = snapshot.update.agentActivity
    if (streamingEvent(snapshot.event) && activity) {
      return this.queueSnapshot(snapshot, activity.id)
    }
    this.store.flush(this.identity)
    const previous = this.flushPending()
    return this.enqueue(snapshot, previous)
  }

  terminate(event: AgentEvent): Promise<unknown> {
    if (!terminalAgentRunEvent(event)) return this.push(event)
    if (this.termination) return this.termination
    const snapshot = this.getTerminalSnapshot(event)
    if (!snapshot) return this.persistence
    this.store.flush(this.identity)
    const previous = this.flushPending()
    const persisted = this.enqueue(snapshot, previous)
    this.termination = this.acknowledgeTermination(persisted)
    return this.termination
  }

  flush() {
    this.store.flush(this.identity)
    return this.flushPending()
  }

  disconnect() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    return this.flush()
  }

  clear() {
    this.store.clear(this.identity)
  }

  private publishActivities(update: AgentFlowUpdate, sequenceNumber: number) {
    const activities =
      update.agentActivityUpdates ??
      (update.agentActivity ? [update.agentActivity] : [])
    this.store.publish(this.identity, activities, sequenceNumber)
  }

  private createSnapshot(event: AgentEvent) {
    if (this.previouslyHandled(event)) return undefined
    if (event.eventId && this.seenEventIds.has(event.eventId)) return undefined
    if (event.eventId) this.seenEventIds.add(event.eventId)
    this.handledSequenceNumber = Math.max(
      this.handledSequenceNumber,
      event.sequenceNumber ?? 0
    )
    const persistentEvent = this.persistentEvent(event)
    const update = agentFlowUpdate(this.state, persistentEvent.event)
    this.state = applyFlowUpdate(this.state, update)
    this.publishActivities(
      update,
      persistentEvent.persistenceEvent.sequenceNumber
    )
    return { ...persistentEvent, update }
  }

  private getTerminalSnapshot(event: AgentEvent) {
    if (this.terminalSnapshot) return this.terminalSnapshot
    const snapshot = this.createSnapshot(event)
    if (!snapshot) return undefined
    const activities = this.state.agentActivities ?? []
    this.terminalSnapshot = {
      ...snapshot,
      update: {
        ...snapshot.update,
        agentActivities: activities,
        agentActivity: activities.at(-1),
        agentActivityUpdates: activities,
      },
    }
    return this.terminalSnapshot
  }

  private acknowledgeTermination(persisted: Promise<unknown>) {
    return persisted.then(
      (result) => {
        this.clear()
        return result
      },
      (error) => {
        this.termination = undefined
        throw error
      }
    )
  }

  private recoverSnapshots(snapshots: RecoveredAgentSnapshot[]) {
    snapshots
      .sort(
        (left, right) => left.event.sequenceNumber - right.event.sequenceNumber
      )
      .forEach((snapshot) => {
        this.seenEventIds.add(snapshot.event.eventId)
        const update = recoveredFlowUpdate(this.state, snapshot.update)
        this.state = applyFlowUpdate(this.state, update)
        this.sequenceNumber = Math.max(
          this.sequenceNumber,
          snapshot.event.sequenceNumber
        )
        this.handledSequenceNumber = Math.max(
          this.handledSequenceNumber,
          snapshot.event.sequenceNumber
        )
        this.store.seed(
          this.identity,
          recoveredActivities(update),
          snapshot.event.sequenceNumber
        )
      })
  }

  private previouslyHandled(event: AgentEvent) {
    return (
      typeof event.sequenceNumber === "number" &&
      event.sequenceNumber <= this.handledSequenceNumber
    )
  }

  private queueSnapshot(
    snapshot: AgentStreamSnapshotPersistence,
    activityId: string
  ) {
    if (this.pending && this.pending.activityId !== activityId)
      this.flushPending()
    const bytes = this.pending?.bytes ?? 0
    this.pending = {
      ...snapshot,
      activityId,
      bytes: bytes + eventTextBytes(snapshot.event),
    }
    if (this.pending.bytes >= snapshotByteThreshold) return this.flushPending()
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      void this.flushPending().catch(this.input.onError)
    }, snapshotIntervalMs)
    return Promise.resolve(undefined)
  }

  private flushPending() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const pending = this.pending
    this.pending = undefined
    if (!pending) return this.persistence
    const { activityId, bytes, ...snapshot } = pending
    void activityId
    void bytes
    return this.enqueue(snapshot, this.persistence)
  }

  private enqueue(
    snapshot: AgentStreamSnapshotPersistence,
    after: Promise<unknown>
  ) {
    const persistence = after
      .catch(() => undefined)
      .then(() => this.input.persist(snapshot))
    this.persistence = persistence
    return persistence
  }

  private persistentEvent(event: AgentEvent) {
    const persistenceEvent = agentPersistenceEvent(event, {
      executionId: this.input.executionId,
      lastSequenceNumber: this.sequenceNumber,
      ...this.identity,
    })
    this.sequenceNumber = persistenceEvent.sequenceNumber
    const normalized = {
      ...event,
      ...persistenceEvent,
    }
    return {
      event: normalized,
      persistenceEvent,
    }
  }
}

export function agentPersistenceEvent(
  event: AgentEvent,
  identity: AgentPersistenceIdentity
): AgentPersistenceEvent {
  return {
    createdAt: event.createdAt ?? new Date().toISOString(),
    eventId: event.eventId ?? randomEventId(),
    eventType: event.eventType ?? event.type,
    executionId: event.executionId ?? identity.executionId,
    runId: identity.runId,
    sequenceNumber: Math.max(
      (identity.lastSequenceNumber ?? 0) + 1,
      event.sequenceNumber ?? 0
    ),
    sessionId: event.sessionId ?? identity.sessionId,
  }
}

function applyFlowUpdate(state: AgentFlowState, update: AgentFlowUpdate) {
  return {
    ...state,
    ...(update.agentActivities !== undefined
      ? { agentActivities: fullDetailActivities(update) }
      : {}),
    ...(update.agentFinalResponse !== undefined
      ? { agentFinalResponse: update.agentFinalResponse }
      : {}),
    ...(update.agentSessionSummary !== undefined
      ? { agentSessionSummary: update.agentSessionSummary }
      : {}),
    ...(update.agentUsage !== undefined
      ? { agentUsage: update.agentUsage }
      : {}),
  }
}

function fullDetailActivities(update: AgentFlowUpdate) {
  const activities = update.agentActivities ?? []
  const activity = update.agentActivity
  if (!activity) return activities
  return activities.map((candidate) =>
    candidate.id === activity.id ? activity : candidate
  )
}

function recoveredFlowUpdate(state: AgentFlowState, value: unknown) {
  if (!value || typeof value !== "object") return {}
  const input = value as Record<string, unknown>
  const updates = activityList(
    input.agentActivityUpdates ?? input.activities ?? input.agentActivity
  )
  const update: AgentFlowUpdate = {}
  if (updates.length) {
    update.agentActivities = mergeAgentActivities(
      state.agentActivities ?? [],
      updates
    )
    update.agentActivityUpdates = updates
    update.agentActivity = updates.at(-1)
  }
  if (typeof input.finalResponse === "string") {
    update.agentFinalResponse = input.finalResponse
  }
  if (typeof input.sessionSummary === "string") {
    update.agentSessionSummary = input.sessionSummary
  }
  if (input.usage && typeof input.usage === "object") {
    update.agentUsage = input.usage as AgentFlowUpdate["agentUsage"]
  }
  return update
}

function activityList(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter(agentActivityValue)
  }
  return agentActivityValue(value) ? [value] : []
}

function agentActivityValue(
  value: unknown
): value is NonNullable<AgentFlowUpdate["agentActivity"]> {
  if (!value || typeof value !== "object") return false
  const activity = value as Record<string, unknown>
  return typeof activity.id === "string" && typeof activity.kind === "string"
}

function recoveredActivities(update: AgentFlowUpdate) {
  return (
    update.agentActivityUpdates ??
    (update.agentActivity ? [update.agentActivity] : [])
  )
}

function streamingEvent(event: AgentEvent) {
  return event.type === "text" || event.type === "reasoning"
}

function eventTextBytes(event: AgentEvent) {
  const payload = event.payload
  if (!payload || typeof payload !== "object") return 0
  const record = payload as Record<string, unknown>
  const value = record.text ?? record.reasoning ?? ""
  if (typeof value !== "string") return 0
  return new TextEncoder().encode(value).byteLength
}

function randomEventId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}
