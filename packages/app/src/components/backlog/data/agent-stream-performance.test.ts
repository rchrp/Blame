import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import test, { mock } from "node:test"

import type { AgentEvent } from "@blame/agent-runtime"
import { createAgentEventCoalescer } from "@blame/agent-runtime/agent-event-coalescer"

import type { UserStoryAgentActivity } from "./backlog-data.ts"
import { resumableEventStreamUrl } from "./agent-event-stream-url.ts"
import {
  pendingAgentSnapshots,
  persistAgentSnapshot,
} from "./agent-snapshot-outbox.ts"
import { AgentStreamCoordinator } from "./agent-stream-coordinator.ts"
import { AgentStreamStore } from "./agent-stream-store.ts"

class FrameScheduler {
  private callbacks = new Map<number, () => void>()
  private nextFrame = 1

  cancel(frame: number) {
    this.callbacks.delete(frame)
  }

  request(callback: () => void) {
    const frame = this.nextFrame
    this.nextFrame += 1
    this.callbacks.set(frame, callback)
    return frame
  }

  paint() {
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    callbacks.forEach((callback) => callback())
  }
}

test("paints the first native delta within one frame", async () => {
  const frames = new FrameScheduler()
  const store = new AgentStreamStore(frames)
  const coordinator = coordinatorWith(store, () => undefined)
  const receivedAt = performance.now()
  coordinator.push(delta(1, "hello"))
  frames.paint()

  assert.ok(performance.now() - receivedAt < 100)
  assert.equal(streamedActivity(store)?.detail, "hello")
  await coordinator.disconnect()
})

test("keeps structured live tool detail when a truncated snapshot arrives", () => {
  const frames = new FrameScheduler()
  const store = new AgentStreamStore(frames)
  const liveActivity = structuredToolActivity("running")
  store.publish(identity, [liveActivity], 1)
  frames.paint()
  store.seed(
    identity,
    [
      {
        ...liveActivity,
        detail: '{"toolName":"read_file"\n...\n"result":"done"}',
        detailArtifact: "agent-activity://tool-1",
        detailTruncated: true,
        status: "completed",
        toolName: undefined,
        updatedAt: "2026-06-11T10:00:02.000Z",
      },
    ],
    2
  )

  const activity = streamedActivity(store)
  assert.equal(activity?.detail, liveActivity.detail)
  assert.equal(activity?.status, "completed")
  assert.equal(activity?.toolName, "read_file")
  assert.equal(activity?.detailTruncated, true)
})

test("adds the confirmed sequence to a resumed event stream", () => {
  const url = resumableEventStreamUrl(
    "http://127.0.0.1:1234/agent/sessions/session/events?token=secret",
    42
  )

  assert.equal(new URL(url).searchParams.get("lastEventId"), "42")
  assert.equal(new URL(url).searchParams.get("token"), "secret")
})

test("processes thousands of deltas with frame-bound renders and bounded writes", async () => {
  const frames = new FrameScheduler()
  const store = new AgentStreamStore(frames)
  let writes = 0
  let inactiveRenders = 0
  const unsubscribe = store.subscribeOrder(
    { runId: "run-2", sessionId: "session-2" },
    () => {
      inactiveRenders += 1
    }
  )
  const coordinator = coordinatorWith(store, () => {
    writes += 1
  })
  const startedAt = performance.now()
  coordinator.push(delta(1, "x"))
  frames.paint()
  const initialOrder = store.orderSnapshot(identity)
  store.resetMetrics()
  for (let sequence = 2; sequence <= 5_000; sequence += 1) {
    coordinator.push(delta(sequence, "x"))
  }
  frames.paint()
  await coordinator.flush()
  const elapsedMs = performance.now() - startedAt

  assert.equal(store.renders(), 1)
  assert.equal(store.orderRenders(), 0)
  assert.equal(store.orderSnapshot(identity), initialOrder)
  assert.equal(inactiveRenders, 0)
  assert.ok(writes <= 2)
  assert.ok(elapsedMs < 1_000)
  assert.equal(streamedActivity(store)?.detail.length, 5_000)
  unsubscribe()
  await coordinator.disconnect()
})

test("keeps messages and tools in distinct ordered containers", async () => {
  const frames = new FrameScheduler()
  const store = new AgentStreamStore(frames)
  const coordinator = coordinatorWith(store, () => undefined)

  coordinator.push(delta(1, "message A"))
  frames.paint()
  await coordinator.push(toolEvent(2, "tool_call", "tool-1"))
  frames.paint()
  await coordinator.push(toolEvent(3, "tool_result", "tool-1"))
  frames.paint()
  coordinator.push(delta(4, "message B"))
  frames.paint()

  assert.deepEqual(
    streamedActivities(store).map((item) => item.kind),
    ["message", "tool", "message"]
  )
  assert.equal(new Set(streamedActivityIds(store)).size, 3)
  await coordinator.disconnect()
})

test("keeps successive tools as separate activities", async () => {
  const frames = new FrameScheduler()
  const store = new AgentStreamStore(frames)
  const coordinator = coordinatorWith(store, () => undefined)

  await coordinator.push(toolEvent(1, "tool_call", "tool-1"))
  await coordinator.push(toolEvent(2, "tool_result", "tool-1"))
  await coordinator.push(toolEvent(3, "tool_call", "tool-2"))
  frames.paint()

  const tools = streamedActivities(store).filter((item) => item.kind === "tool")
  assert.equal(tools.length, 2)
  assert.notEqual(tools[0]?.id, tools[1]?.id)
  await coordinator.disconnect()
})

test("keeps optimistic activities after a persistence failure", async () => {
  const frames = new FrameScheduler()
  const store = new AgentStreamStore(frames)
  const coordinator = coordinatorWith(store, () =>
    Promise.reject(new Error("offline"))
  )

  coordinator.push(delta(1, "still visible"))
  frames.paint()
  await assert.rejects(coordinator.flush(), /offline/)

  assert.equal(streamedActivity(store)?.detail, "still visible")
  await coordinator.disconnect().catch(() => undefined)
})

test("keeps a failed finalization visible and retries the same outbox snapshot", async () => {
  const frames = new FrameScheduler()
  const storage = memoryStorage()
  const store = new AgentStreamStore(frames)
  const terminalSnapshots: AgentStreamSnapshot[] = []
  let backendFails = true
  let canonicalSnapshot: AgentStreamSnapshot | undefined
  const coordinator = coordinatorWith(store, (snapshot) => {
    if (snapshot.event.type !== "done") return undefined
    terminalSnapshots.push(snapshot)
    return persistAgentSnapshot(
      storage,
      durableSnapshot(snapshot),
      async () => {
        assert.equal(pendingAgentSnapshots(storage, "project-1").length, 1)
        if (backendFails) throw new Error("offline")
        canonicalSnapshot = snapshot
      }
    )
  })
  coordinator.push(delta(1, "message A"))
  await coordinator.push(toolEvent(2, "tool_call", "tool-1"))
  await coordinator.push(toolEvent(3, "tool_result", "tool-1"))
  coordinator.push(delta(4, "message B"))
  const terminalEvent = doneEvent(5)

  await assert.rejects(coordinator.terminate(terminalEvent), /offline/)

  assert.deepEqual(
    streamedActivities(store).map((activity) => activity.kind),
    ["message", "tool", "message"]
  )
  const pending = pendingAgentSnapshots(storage, "project-1")
  assert.equal(pending.length, 1)
  assert.equal(finalizedActivities(pending[0]?.update).length, 3)

  backendFails = false
  await coordinator.terminate(terminalEvent)

  assert.equal(pendingAgentSnapshots(storage, "project-1").length, 0)
  assert.equal(store.orderSnapshot(identity).activityIds.length, 0)
  assert.equal(finalizedActivities(canonicalSnapshot?.update).length, 3)
  assert.equal(terminalSnapshots.length, 2)
  assert.equal(
    terminalSnapshots[0]?.persistenceEvent.eventId,
    terminalSnapshots[1]?.persistenceEvent.eventId
  )
  assert.equal(
    terminalSnapshots[0]?.persistenceEvent.sequenceNumber,
    terminalSnapshots[1]?.persistenceEvent.sequenceNumber
  )
})

test("finalizes a cancellation once with the coordinator latest sequence", async () => {
  const snapshots: AgentStreamSnapshot[] = []
  const coordinator = new AgentStreamCoordinator({
    ...identity,
    executionId: "00000000-0000-4000-8000-000000000001",
    initialState: {},
    lastSequenceNumber: 10,
    persist: (snapshot) => void snapshots.push(snapshot),
    store: new AgentStreamStore(new FrameScheduler()),
  })
  coordinator.push(delta(11, "message A"))
  await coordinator.push(toolEvent(12, "tool_call", "tool-1"))
  await coordinator.push(toolEvent(13, "tool_result", "tool-1"))
  coordinator.push(delta(14, "message B"))
  const stopped = doneEvent(undefined, "aborted")

  await coordinator.terminate(stopped)
  await coordinator.terminate(stopped)

  const terminalSnapshots = snapshots.filter(
    (snapshot) => snapshot.event.type === "done"
  )
  assert.equal(terminalSnapshots.length, 1)
  assert.equal(terminalSnapshots[0]?.persistenceEvent.sequenceNumber, 15)
  assert.deepEqual(
    terminalSnapshots[0]?.update.agentActivityUpdates?.map(
      (activity) => activity.kind
    ),
    ["message", "tool", "message"]
  )
  assert.equal(
    terminalSnapshots[0]?.update.agentActivityUpdates?.[1]?.toolCallId,
    "tool-1"
  )
})

test("merges recovered snapshots and ignores replayed event ids", async () => {
  const firstFrames = new FrameScheduler()
  const persisted: AgentStreamSnapshot[] = []
  const first = coordinatorWith(
    new AgentStreamStore(firstFrames),
    (snapshot) => {
      persisted.push(snapshot)
    }
  )
  first.push(delta(1, "message A"))
  await first.push(toolEvent(2, "tool_call", "tool-1"))
  first.push(delta(3, "message B"))
  await first.flush()
  await first.disconnect()

  const toolStore = recoveredStore(persisted.slice(0, 2))
  assert.deepEqual(
    streamedActivities(toolStore).map((item) => item.kind),
    ["message", "tool"]
  )
  assert.equal(streamedActivity(toolStore)?.status, "running")

  const store = new AgentStreamStore(new FrameScheduler())
  const resumed = new AgentStreamCoordinator({
    ...identity,
    executionId: "00000000-0000-4000-8000-000000000001",
    initialState: {},
    lastSequenceNumber: 0,
    persist: () => undefined,
    recoveredSnapshots: persisted.map((snapshot) => ({
      event: snapshot.persistenceEvent,
      update: snapshot.update,
    })),
    store,
  })
  resumed.push(delta(3, "message B"))

  assert.deepEqual(
    streamedActivities(store).map((item) => item.kind),
    ["message", "tool", "message"]
  )
  assert.equal(streamedActivity(store)?.detail, "message B")
  await resumed.disconnect()
})

test("does not replay deltas already covered by a recovered snapshot", async () => {
  const persisted: AgentStreamSnapshot[] = []
  const first = coordinatorWith(
    new AgentStreamStore(new FrameScheduler()),
    (snapshot) => {
      persisted.push(snapshot)
    }
  )
  first.push(delta(1, "A"))
  first.push(delta(2, "B"))
  await first.flush()
  await first.disconnect()

  const store = recoveredStore(persisted)
  const resumed = new AgentStreamCoordinator({
    ...identity,
    executionId: "00000000-0000-4000-8000-000000000001",
    initialState: {},
    persist: () => undefined,
    recoveredSnapshots: persisted.map((snapshot) => ({
      event: snapshot.persistenceEvent,
      update: snapshot.update,
    })),
    store,
  })
  resumed.push(delta(1, "A"))

  assert.equal(streamedActivity(store)?.detail, "AB")
  await resumed.disconnect()
})

test("flushes text before an activity boundary", async () => {
  const frames = new FrameScheduler()
  const store = new AgentStreamStore(frames)
  const persisted: string[] = []
  const coordinator = coordinatorWith(store, (snapshot) => {
    persisted.push(snapshot.event.type)
  })
  coordinator.push(delta(1, "hello"))
  await coordinator.push({
    ...event(2, "tool"),
    payload: { phase: "start", toolName: "read_file" },
  })

  assert.deepEqual(persisted, ["text", "tool"])
  await coordinator.disconnect()
})

test("renders the same conversation whether deltas arrive one by one or merged by the worker", async () => {
  const oneByOne = sequenced(streamedRun().map(({ event }) => event))
  const merged = sequenced(coalescedRun(streamedRun()))

  assert.ok(merged.length < oneByOne.length / 2)
  assert.deepEqual(await renderedRun(merged), await renderedRun(oneByOne))
})

test("a reconnection replaying merged deltas renders the whole conversation", async () => {
  const merged = sequenced(coalescedRun(streamedRun()))
  const persisted: AgentStreamSnapshot[] = []
  const first = coordinatorWith(
    new AgentStreamStore(new FrameScheduler()),
    (snapshot) => {
      persisted.push(snapshot)
    }
  )
  merged.slice(0, 9).forEach((value) => void first.push(value))
  await first.disconnect()

  const store = recoveredStore(persisted)
  const resumed = new AgentStreamCoordinator({
    ...identity,
    executionId: "00000000-0000-4000-8000-000000000001",
    initialState: {},
    persist: () => undefined,
    recoveredSnapshots: persisted.map((snapshot) => ({
      event: snapshot.persistenceEvent,
      update: snapshot.update,
    })),
    store,
  })
  merged.forEach((value) => void resumed.push(value))
  await resumed.disconnect()

  assert.deepEqual(
    renderedActivities(store),
    await renderedRun(sequenced(streamedRun().map(({ event }) => event)))
  )
})

const identity = { runId: "run-1", sessionId: "session-1" }

function coordinatorWith(
  store: AgentStreamStore,
  persist: ConstructorParameters<typeof AgentStreamCoordinator>[0]["persist"]
) {
  return new AgentStreamCoordinator({
    ...identity,
    executionId: "00000000-0000-4000-8000-000000000001",
    initialState: {},
    persist,
    store,
  })
}

function delta(sequenceNumber: number, text: string): AgentEvent {
  return {
    ...event(sequenceNumber, "text"),
    payload: { iteration: 1, text },
  }
}

function toolEvent(
  sequenceNumber: number,
  hookEventName: "tool_call" | "tool_result",
  toolCallId: string
): AgentEvent {
  return {
    ...event(sequenceNumber, "tool"),
    payload: {
      hookEventName,
      iteration: 1,
      toolCallId,
      toolName: "read_file",
    },
  }
}

function doneEvent(sequenceNumber?: number, reason?: string): AgentEvent {
  return {
    ...(sequenceNumber === undefined ? {} : event(sequenceNumber, "done")),
    payload: { reason, text: "Agent stopped." },
    type: "done",
  }
}

type AgentStreamSnapshot = Parameters<
  ConstructorParameters<typeof AgentStreamCoordinator>[0]["persist"]
>[0]

function streamedActivityIds(store: AgentStreamStore) {
  return store.orderSnapshot(identity).activityIds
}

function streamedActivities(store: AgentStreamStore) {
  return streamedActivityIds(store).flatMap((activityId) => {
    const activity = store.activitySnapshot(identity, activityId)?.activity
    return activity ? [activity] : []
  })
}

function streamedActivity(store: AgentStreamStore) {
  return streamedActivities(store).at(-1)
}

function structuredToolActivity(
  status: "running" | "completed"
): UserStoryAgentActivity {
  return {
    createdAt: "2026-06-11T10:00:00.000Z",
    detail: JSON.stringify({
      input: { path: "package.json" },
      toolName: "read_file",
    }),
    id: "tool-1",
    kind: "tool",
    status,
    title: "Read file",
    toolCallId: "call-1",
    toolName: "read_file",
    updatedAt: "2026-06-11T10:00:01.000Z",
  }
}

function durableSnapshot(snapshot: AgentStreamSnapshot) {
  return {
    event: snapshot.persistenceEvent,
    messageId: snapshot.update.agentActivity?.id ?? snapshot.event.type,
    projectId: "project-1",
    runId: identity.runId,
    targetId: "story-1",
    targetType: "user-story" as const,
    update: snapshot.update,
  }
}

function finalizedActivities(value: unknown) {
  if (!value || typeof value !== "object") return []
  const update = value as AgentStreamSnapshot["update"]
  return update.agentActivityUpdates ?? []
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  }
}

function recoveredStore(snapshots: AgentStreamSnapshot[]) {
  const store = new AgentStreamStore(new FrameScheduler())
  new AgentStreamCoordinator({
    ...identity,
    executionId: "00000000-0000-4000-8000-000000000001",
    initialState: {},
    persist: () => undefined,
    recoveredSnapshots: snapshots.map((snapshot) => ({
      event: snapshot.persistenceEvent,
      update: snapshot.update,
    })),
    store,
  })
  return store
}

function event(sequenceNumber: number, type: AgentEvent["type"]): AgentEvent {
  return {
    createdAt: new Date().toISOString(),
    eventId: `event-${sequenceNumber}`,
    eventType: type,
    executionId: "00000000-0000-4000-8000-000000000001",
    payload: {},
    sequenceNumber,
    sessionId: identity.sessionId,
    type,
  }
}

type TimedEvent = { at: number; event: AgentEvent }

// Deltas as a model streams them: reasoning, an answer split around a tool,
// a blank delta opening a message, and a second iteration.
function streamedRun(): TimedEvent[] {
  const run: TimedEvent[] = []
  let at = 0
  const push = (type: AgentEvent["type"], payload: object, gapMs = 4) => {
    at += gapMs
    run.push({ at, event: { payload, sessionId: identity.sessionId, type } })
  }
  const stream = (
    type: "reasoning" | "text",
    text: string,
    iteration: number
  ) =>
    text
      .split(/(?<= )/)
      .forEach((piece) =>
        push(type, { iteration, phase: "started", text: piece })
      )
  stream("reasoning", "Je regarde le fichier de configuration avant tout. ", 1)
  stream("text", "Je vais lire package.json puis les tests. ", 1)
  push("tool", {
    iteration: 1,
    phase: "started",
    toolCall: {
      id: "call-1",
      input: { path: "package.json" },
      name: "read_files",
    },
  })
  push(
    "tool",
    {
      iteration: 1,
      output: { content: "{}" },
      phase: "finished",
      toolCall: { id: "call-1", name: "read_files" },
    },
    60
  )
  push("text", { iteration: 1, phase: "started", text: "\n\n" })
  stream("text", "Le fichier est vide, je le complète. ", 1)
  push("text", { iteration: 1, phase: "finished" })
  stream("reasoning", "Il reste à lancer les tests unitaires. ", 2)
  stream("text", "Les tests passent tous maintenant. ", 2)
  return run
}

function coalescedRun(run: TimedEvent[]) {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const sent: AgentEvent[] = []
    const coalescer = createAgentEventCoalescer((value) => sent.push(value))
    let now = 0
    for (const { at, event: value } of run) {
      mock.timers.tick(at - now)
      now = at
      coalescer.push(value)
    }
    coalescer.flush()
    return sent
  } finally {
    mock.timers.reset()
  }
}

function sequenced(events: AgentEvent[]) {
  return events.map((value, index) => ({
    ...event(index + 1, value.type),
    payload: value.payload,
  }))
}

async function renderedRun(events: AgentEvent[]) {
  const frames = new FrameScheduler()
  const store = new AgentStreamStore(frames)
  const coordinator = coordinatorWith(store, () => undefined)
  events.forEach((value) => {
    void coordinator.push(value)
    frames.paint()
  })
  await coordinator.disconnect()
  return renderedActivities(store)
}

function renderedActivities(store: AgentStreamStore) {
  return streamedActivities(store).map(
    ({ detail, id, iteration, kind, status, title }) => ({
      detail,
      id,
      iteration,
      kind,
      status,
      title,
    })
  )
}
