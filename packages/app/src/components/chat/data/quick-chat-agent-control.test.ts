import assert from "node:assert/strict"
import test from "node:test"

import { registerRunStream } from "../../backlog/data/agent-run-streams.ts"
import {
  QuickChatAgentOperations,
  quickChatAgentRunning,
  quickChatStreamKey,
  stopQuickChatAgent,
} from "./quick-chat-agent-control.ts"
import type {
  QuickChat,
  QuickChatAgentRunFinalization,
} from "./quick-chat-data.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(id: string) {
  let chat: QuickChat = {
    id,
    projectId: "project",
    title: "Chat",
    createdAt: "2026-10-26T10:00:00Z",
    agentStatus: "Running",
    clineSessionId: "session",
    agentRuns: [
      {
        id: `${id}-run`,
        quickChatId: id,
        kind: "resume",
        status: "running",
        createdAt: "2026-10-26T10:00:00Z",
        clineSessionId: "session",
        executionId: "execution",
        lastSequenceNumber: 3,
      },
    ],
  }
  const events: string[] = []
  const finalizations: QuickChatAgentRunFinalization[] = []
  const dependencies: Parameters<typeof stopQuickChatAgent>[1] = {
    async loadDetail() {
      events.push("load")
      return chat
    },
    async abort(id) {
      events.push(`abort:${id}`)
    },
    async finalizeAgentRun(_, run, input) {
      events.push("finalize")
      finalizations.push(input)
      chat = {
        ...chat,
        agentStatus: input.agentStatus,
        agentRuns: chat.agentRuns!.map((item) =>
          item.id === run.id ? { ...item, status: input.status } : item
        ),
      }
      return chat
    },
    async update(_, input) {
      events.push("update")
      chat = { ...chat, ...input }
      return chat
    },
  }
  return {
    dependencies,
    events,
    finalizations,
    get chat() {
      return chat
    },
    set chat(value: QuickChat) {
      chat = value
    },
  }
}

test("stops a chat loaded from a sidebar summary without a mounted stream", async () => {
  const f = fixture("offscreen")
  const stopped = await stopQuickChatAgent({ id: f.chat.id }, f.dependencies)
  assert.deepEqual(f.events, [
    "load",
    "abort:session",
    "load",
    "finalize",
    "update",
  ])
  assert.equal(stopped.agentStatus, "Paused")
  assert.equal(stopped.agentRuns?.[0].status, "cancelled")
  assert.equal(f.finalizations[0].persistenceEvent?.sequenceNumber, 4)
  assert.equal(f.finalizations[0].finalResponse, "Agent stopped.")
})

test("the composer offers stop during startup and respects a paused chat", () => {
  const f = fixture("starting")
  assert.equal(quickChatAgentRunning({ ...f.chat, agentStatus: null }), true)
  assert.equal(
    quickChatAgentRunning({ ...f.chat, agentStatus: "Paused" }),
    false
  )
  assert.equal(quickChatAgentRunning({ ...f.chat, agentRuns: undefined }), true)
  assert.equal(
    quickChatAgentRunning({ ...f.chat, agentStatus: null, agentRuns: [] }),
    false
  )
  assert.equal(quickChatAgentRunning(undefined), false)
})

test("waits for stream persistence before finalizing and deleting a running chat", async () => {
  const f = fixture("streaming")
  const flushing = deferred()
  const startedFlush = deferred()
  registerRunStream(
    "streaming-run",
    quickChatStreamKey(f.chat.id),
    () => f.events.push("close"),
    async () => {
      f.events.push("flush")
      startedFlush.resolve()
      await flushing.promise
      f.chat = {
        ...f.chat,
        agentRuns: [{ ...f.chat.agentRuns![0], lastSequenceNumber: 12 }],
      }
    }
  )
  const deleting = stopQuickChatAgent(f.chat, f.dependencies).then(() => {
    f.events.push("delete")
  })
  await startedFlush.promise
  assert.deepEqual(f.events, ["load", "abort:session", "close", "flush"])
  flushing.resolve()
  await deleting
  assert.deepEqual(f.events.slice(-4), ["load", "finalize", "update", "delete"])
  assert.equal(f.finalizations[0].persistenceEvent?.sequenceNumber, 13)
})

test("an abort failure prevents deletion and leaves the run running", async () => {
  const f = fixture("failure")
  f.dependencies.abort = async () => {
    throw new Error("Runtime unavailable")
  }
  await assert.rejects(
    stopQuickChatAgent(f.chat, f.dependencies).then(() =>
      assert.fail("deleted before stopping")
    ),
    /Runtime unavailable/
  )
  assert.equal(f.chat.agentStatus, "Running")
  assert.equal(f.finalizations.length, 0)
})

test("a terminal event during abort still leaves the chat paused", async () => {
  const f = fixture("terminal-race")
  f.dependencies.abort = async () => {
    f.chat = {
      ...f.chat,
      agentStatus: null,
      agentRuns: [{ ...f.chat.agentRuns![0], status: "cancelled" }],
    }
  }
  const stopped = await stopQuickChatAgent(f.chat, f.dependencies)
  assert.equal(stopped.agentStatus, "Paused")
  assert.equal(f.finalizations.length, 0)
})

test("idle chats can be deleted without an available agent runtime", async () => {
  const f = fixture("idle")
  f.chat = {
    ...f.chat,
    agentStatus: null,
    agentRuns: [{ ...f.chat.agentRuns![0], status: "completed" }],
  }
  f.dependencies.abort = undefined
  assert.equal(await stopQuickChatAgent(f.chat, f.dependencies), f.chat)
  assert.deepEqual(f.events, ["load"])
})

test("active chats cannot be silently deleted without a session or runtime", async () => {
  const f = fixture("missing-runtime")
  f.dependencies.abort = undefined
  await assert.rejects(
    stopQuickChatAgent(f.chat, f.dependencies),
    /runtime is not available/
  )
  f.chat = { ...f.chat, clineSessionId: null, agentRuns: [] }
  await assert.rejects(
    stopQuickChatAgent(f.chat, f.dependencies),
    /session is not available/
  )
})

test("stopping during startup waits for the session and deduplicates concurrent stops", async () => {
  const operations = new QuickChatAgentOperations()
  const startup = deferred()
  const stopped = deferred()
  const events: string[] = []
  const starting = operations.start("chat", async () => {
    await startup.promise
    events.push("session-ready")
  })
  const stopping = operations.stop("chat", async () => {
    events.push("abort")
    await stopped.promise
  })
  assert.equal(
    operations.stop("chat", async () => assert.fail("duplicate abort")),
    stopping
  )
  assert.equal(operations.snapshot().has("chat"), true)
  await assert.rejects(
    operations.start("chat", async () => assert.fail("started during stop")),
    /starting or stopping/
  )
  assert.deepEqual(events, [])
  startup.resolve()
  await starting
  await Promise.resolve()
  assert.deepEqual(events, ["session-ready", "abort"])
  assert.equal(operations.snapshot().has("chat"), true)
  stopped.resolve()
  await stopping
  assert.equal(operations.snapshot().has("chat"), false)
  await operations.start("chat", async () => events.push("next-turn"))
  assert.equal(events.at(-1), "next-turn")
})

test("failed startup does not prevent a stop or lock unrelated chats", async () => {
  const operations = new QuickChatAgentOperations()
  const starting = operations.start("chat", async () => {
    throw new Error("Startup failed")
  })
  const stopping = operations.stop("chat", async () => "stopped")
  assert.equal(
    await operations.start("other", async () => "other-started"),
    "other-started"
  )
  await assert.rejects(starting, /Startup failed/)
  assert.equal(await stopping, "stopped")
  assert.equal(operations.snapshot().size, 0)
})

test("deletion blocks a concurrent send-now even after abort completes, until undo", async () => {
  const operations = new QuickChatAgentOperations()
  operations.preventStarts("deleting")
  await operations.stop("deleting", async () => undefined)
  await assert.rejects(
    operations.start("deleting", async () =>
      assert.fail("restarted a deleted chat")
    ),
    /starting or stopping/
  )
  assert.equal(operations.snapshot().has("deleting"), true)
  operations.allowStarts("deleting")
  await operations.start("deleting", async () => "resumed after undo")
  assert.equal(operations.snapshot().has("deleting"), false)
})
