import assert from "node:assert/strict"
import test from "node:test"
import {
  dropQueuedComments,
  queueComment,
  queuedComments,
} from "../backlog/comment-queue.ts"
import { QuickChatQueueDelivery } from "./quick-chat-queue-delivery.ts"

function queue(chatId: string, body: string) {
  return queueComment({
    storyId: `chat:${chatId}`,
    body,
    codeSelectionAttachments: [],
    fileAttachments: [],
  })
}

test("queued messages are sent together after a turn and removed only once accepted", async () => {
  const delivery = new QuickChatQueueDelivery()
  queue("finished", "First")
  queue("finished", "Second")
  await delivery.deliver({
    chatId: "finished",
    automatic: true,
    async send(id, message) {
      assert.equal(id, "finished")
      assert.equal(message.body, "First\n\nSecond")
      assert.equal(queuedComments("chat:finished").length, 2)
    },
  })
  assert.equal(queuedComments("chat:finished").length, 0)
})

test("send now waits for abort, sends only the selected message and resists auto-delivery races", async () => {
  const delivery = new QuickChatQueueDelivery()
  const selected = queue("interrupt", "Now")
  queue("interrupt", "Later")
  let finishStop!: () => void
  const stop = new Promise<void>((resolve) => {
    finishStop = resolve
  })
  const sent: string[] = []
  const pending = delivery.deliver({
    chatId: "interrupt",
    commentId: selected.id,
    stop: () => stop,
    async send(id, message) {
      assert.equal(id, "interrupt")
      sent.push(message.body)
    },
  })
  await delivery.deliver({
    chatId: "interrupt",
    automatic: true,
    async send() {
      assert.fail("automatic delivery overtook stop")
    },
  })
  assert.deepEqual(sent, [])
  finishStop()
  await pending
  assert.deepEqual(sent, ["Now"])
  assert.deepEqual(
    queuedComments("chat:interrupt").map((item) => item.body),
    ["Later"]
  )
  dropQueuedComments("chat:interrupt")
})

test("failed interruption preserves the message and allows explicit retry", async () => {
  const delivery = new QuickChatQueueDelivery()
  const selected = queue("failed-stop", "Keep me")
  await assert.rejects(
    delivery.deliver({
      chatId: "failed-stop",
      commentId: selected.id,
      async stop() {
        throw new Error("Abort failed")
      },
      async send() {
        assert.fail("sent before stopping")
      },
    }),
    /Abort failed/
  )
  assert.equal(queuedComments("chat:failed-stop")[0].id, selected.id)
  await delivery.deliver({
    chatId: "failed-stop",
    automatic: true,
    async send() {
      assert.fail("retried automatically")
    },
  })
  await delivery.deliver({
    chatId: "failed-stop",
    commentId: selected.id,
    async send(_, message) {
      assert.equal(message.body, "Keep me")
    },
  })
  assert.equal(queuedComments("chat:failed-stop").length, 0)
})

test("failed send preserves the original and messages queued during delivery", async () => {
  const delivery = new QuickChatQueueDelivery()
  const selected = queue("failed-send", "Original")
  await assert.rejects(
    delivery.deliver({
      chatId: "failed-send",
      automatic: true,
      async send() {
        queue("failed-send", "Added while sending")
        throw new Error("Offline")
      },
    }),
    /Offline/
  )
  assert.equal(queuedComments("chat:failed-send")[0].id, selected.id)
  assert.equal(queuedComments("chat:failed-send").length, 2)
  dropQueuedComments("chat:failed-send")
})

test("deleting a chat while its stop is pending discards the queued delivery", async () => {
  const delivery = new QuickChatQueueDelivery()
  const selected = queue("deleted", "Don't send")
  await delivery.deliver({
    chatId: "deleted",
    commentId: selected.id,
    async stop(id) {
      dropQueuedComments(`chat:${id}`)
    },
    async send() {
      assert.fail("sent to deleted chat")
    },
  })
})
