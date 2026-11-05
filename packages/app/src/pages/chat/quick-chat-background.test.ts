import assert from "node:assert/strict"
import test from "node:test"

import type {
  QuickChat,
  QuickChatAgentRun,
} from "../../components/chat/data/quick-chat-data.ts"
import {
  quickChatBackgroundWork,
  quickChatsReadyForQueuedMessages,
} from "./quick-chat-background.ts"

test("loads running chats nobody opened and follows their running turns", () => {
  const listed = chat("listed", { agentRuns: [], agentStatus: "Running" })
  const idle = chat("idle", { agentRuns: [] })
  const open = chat("open", {
    agentRuns: [run("done", "completed"), run("current", "running")],
    agentStatus: "Running",
    clineSessionId: "session-open",
  })

  const work = quickChatBackgroundWork([listed, idle, open], {
    busy: new Set(),
    detailsLoaded: (item) => item.id === "open",
    followed: () => false,
  })

  assert.deepEqual(
    work.load.map((item) => item.id),
    ["listed"]
  )
  assert.deepEqual(
    work.follow.map(({ chat, run, sessionId }) => [chat.id, run.id, sessionId]),
    [["open", "current", "session-open"]]
  )
})

test("leaves followed turns and chats that are starting or stopping alone", () => {
  const followed = chat("followed", {
    agentRuns: [run("current", "running", "session-a")],
  })
  const starting = chat("starting", {
    agentRuns: [run("current", "running", "session-b")],
  })

  const work = quickChatBackgroundWork([followed, starting], {
    busy: new Set(["starting"]),
    detailsLoaded: () => true,
    followed: (sessionId) => sessionId === "session-a",
  })

  assert.deepEqual(work, { follow: [], load: [] })
})

test("sends queued messages only to chats whose agent is not working", () => {
  const chats = [
    chat("idle"),
    chat("running", { agentStatus: "Running" }),
    chat("paused", { agentStatus: "Paused" }),
    chat("stopping"),
    chat("nothing-queued"),
  ]

  assert.deepEqual(
    quickChatsReadyForQueuedMessages(
      chats,
      ["idle", "running", "paused", "stopping", "other-project"],
      new Set(["stopping"])
    ),
    ["idle"]
  )
})

function chat(id: string, input: Partial<QuickChat> = {}): QuickChat {
  return {
    createdAt: "2026-11-05T10:00:00.000Z",
    id,
    projectId: "project",
    title: id,
    ...input,
  } as QuickChat
}

function run(
  id: string,
  status: QuickChatAgentRun["status"],
  clineSessionId?: string
): QuickChatAgentRun {
  return {
    clineSessionId,
    createdAt: "2026-11-05T10:00:00.000Z",
    id,
    kind: "change-request",
    quickChatId: "chat",
    status,
  }
}
