import assert from "node:assert/strict"
import test from "node:test"

import type { QuickChatAgentRun } from "./quick-chat-data.ts"
import {
  interruptedQuickChatMessage,
  interruptedQuickChatRunFinalization,
  quickChatRunRecovery,
} from "./quick-chat-run-recovery.ts"

const first = run("first", "2026-11-04T23:30:51.000Z")
const second = run("second", "2026-11-04T23:34:13.000Z")
const chat = { agentRuns: [first, second] }

// The earlier turn of the same session finished; the later one still works.
const sharedLog = [
  logLine("event:done", "2026-11-04T23:33:00.000Z", { finishReason: "stop" }),
  logLine("event:tool", "2026-11-04T23:35:00.000Z"),
].join("\n")

test("does not close a turn from an earlier turn's completion in the shared log", async () => {
  const recovery = await quickChatRunRecovery(chat, second, "session", {
    live: async () => false,
    log: async () => sharedLog,
    messages: async () => [],
  })

  assert.deepEqual(recovery, { kind: "interrupted" })
})

test("closes a finished turn with its own final reply", async () => {
  const recovery = await quickChatRunRecovery(chat, first, "session", {
    live: async () => false,
    log: async () => sharedLog,
    messages: async () => [
      assistant("Earlier reply", "2026-11-04T23:20:00.000Z"),
      assistant("Here is the US-024 review.", "2026-11-04T23:32:59.000Z"),
      assistant("Later turn reply", "2026-11-04T23:36:00.000Z"),
    ],
  })

  assert.deepEqual(recovery, {
    event: { payload: { text: "Here is the US-024 review." }, type: "done" },
    kind: "completed",
  })
})

test("leaves a session the desktop still runs to its stream", async () => {
  let readLog = false
  const recovery = await quickChatRunRecovery(chat, first, "session", {
    live: async () => true,
    log: async () => {
      readLog = true
      return sharedLog
    },
    messages: async () => [],
  })

  assert.equal(recovery, undefined)
  assert.equal(readLog, false)
})

test("keeps waiting when an older desktop cannot tell whether the session runs", async () => {
  const recovery = await quickChatRunRecovery(chat, second, "session", {
    log: async () => sharedLog,
    messages: async () => [],
  })

  assert.equal(recovery, undefined)
})

test("ignores a failed completion line", async () => {
  const recovery = await quickChatRunRecovery(
    { agentRuns: [first] },
    first,
    "session",
    {
      live: async () => false,
      log: async () =>
        logLine("event:done", "2026-11-04T23:31:00.000Z", {
          reason: "aborted",
        }),
      messages: async () => [],
    }
  )

  assert.deepEqual(recovery, { kind: "interrupted" })
})

test("finalizes an interrupted turn as failed and keeps a reply it already had", () => {
  const finalization = interruptedQuickChatRunFinalization(
    { clineSessionId: "session" },
    { ...first, finalResponse: "Partial reply", lastSequenceNumber: 21 },
    "2026-11-05T00:00:00.000Z"
  )

  assert.equal(finalization.status, "failed")
  assert.equal(finalization.agentStatus, null)
  assert.equal(finalization.agentLastError, interruptedQuickChatMessage)
  assert.equal(finalization.finalResponse, "Partial reply")
  assert.equal(finalization.persistenceEvent?.sequenceNumber, 22)
  assert.equal(finalization.persistenceEvent?.sessionId, "session")
})

function run(id: string, createdAt: string): QuickChatAgentRun {
  return {
    clineSessionId: "session",
    createdAt,
    executionId: `${id}-execution`,
    id,
    kind: "change-request",
    quickChatId: "chat",
    status: "running",
  }
}

function logLine(message: string, timestamp: string, payload = {}) {
  return JSON.stringify({ message, payload, timestamp })
}

function assistant(text: string, timestamp: string) {
  return {
    content: [{ text, type: "text" }],
    role: "assistant",
    ts: Date.parse(timestamp),
  }
}
