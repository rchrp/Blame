import assert from "node:assert/strict"
import test from "node:test"

import {
  dropQueuedComments,
  queueComment,
  queuedComments,
  removeQueuedComment,
  takeQueuedComments,
} from "./comment-queue.ts"

const comment = (storyId: string, body: string) => ({
  body,
  codeSelectionAttachments: [],
  fileAttachments: [],
  storyId,
})

test("queues comments per story and takes them as one message", () => {
  queueComment(comment("s1", "Use the blue button"))
  queueComment(comment("s1", "  and keep the old label  "))
  queueComment(comment("s2", "Other story"))
  assert.equal(queuedComments("s1").length, 2)
  const merged = takeQueuedComments("s1")
  assert.equal(merged?.body, "Use the blue button\n\nand keep the old label")
  assert.equal(queuedComments("s1").length, 0)
  assert.equal(queuedComments("s2").length, 1)
  assert.equal(takeQueuedComments("s1"), undefined)
  dropQueuedComments("s2")
})

test("removes a single queued comment", () => {
  const first = queueComment(comment("s3", "first"))
  queueComment(comment("s3", "second"))
  removeQueuedComment(first.id)
  assert.deepEqual(queuedComments("s3").map((item) => item.body), ["second"])
  dropQueuedComments("s3")
  assert.equal(queuedComments("s3").length, 0)
})

test("sends one queued comment now and keeps the others queued", () => {
  const first = queueComment(comment("s5", "First"))
  queueComment(comment("s5", "Second"))
  assert.equal(takeQueuedComments("s5", first.id)?.body, "First")
  assert.deepEqual(
    queuedComments("s5").map((item) => item.body),
    ["Second"]
  )
  dropQueuedComments("s5")
})
