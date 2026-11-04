import assert from "node:assert/strict"
import test from "node:test"

import {
  codeExcerpt,
  createExcerptQueue,
  excerptActions,
  excerptCard,
  messageExcerpt,
  storyAcceptsExcerpts,
} from "./excerpt-model.ts"

test("a code excerpt keeps the selected text and spans the selected lines", () => {
  assert.deepEqual(
    codeExcerpt({
      lineNumbers: [14, 12, 13],
      path: "src/app.ts",
      text: "  const value = 1\n  return value\n}",
    }),
    {
      content: "  const value = 1\n  return value\n}",
      endLine: 14,
      path: "src/app.ts",
      startLine: 12,
    }
  )
})

test("a code excerpt of part of one line points at that line", () => {
  const excerpt = codeExcerpt({
    lineNumbers: [7],
    path: "README.md",
    text: "Blame",
  })
  assert.equal(excerpt?.startLine, 7)
  assert.equal(excerpt?.endLine, 7)
})

test("blank lines around a selection are left out, the indentation stays", () => {
  assert.equal(
    codeExcerpt({
      lineNumbers: [1, 2, 3],
      path: "a.ts",
      text: "\r\n   \n    indented();\r\n\n",
    })?.content,
    "    indented();"
  )
})

test("no code excerpt without text, path or line", () => {
  assert.equal(
    codeExcerpt({ lineNumbers: [1], path: "a.ts", text: " \n " }),
    undefined
  )
  assert.equal(
    codeExcerpt({ lineNumbers: [], path: "a.ts", text: "code" }),
    undefined
  )
  assert.equal(
    codeExcerpt({ lineNumbers: [0, Number.NaN], path: "a.ts", text: "code" }),
    undefined
  )
  assert.equal(
    codeExcerpt({ lineNumbers: [1], path: "", text: "code" }),
    undefined
  )
})

test("a message excerpt names its author and is marked as a message", () => {
  assert.deepEqual(
    messageExcerpt({ author: "agent", text: "First point\n\nSecond point\n" }),
    {
      content: "First point\n\nSecond point",
      endLine: 3,
      origin: "message",
      path: "Agent message",
      startLine: 1,
    }
  )
  assert.equal(
    messageExcerpt({ author: "user", text: "Good night" })?.path,
    "User message"
  )
  assert.equal(messageExcerpt({ author: "user", text: "  " }), undefined)
})

test("done and discarded stories take no more context", () => {
  assert.equal(storyAcceptsExcerpts("done"), false)
  assert.equal(storyAcceptsExcerpts("discarded"), false)
  for (const status of [
    "backlog",
    "ready",
    "in-progress",
    "in-review",
  ] as const) {
    assert.equal(storyAcceptsExcerpts(status), true)
  }
})

test("attaching as context is offered first, only where it can land", () => {
  assert.deepEqual(excerptActions(true), [
    "attach-as-context",
    "new-user-story",
    "new-chat",
  ])
  assert.deepEqual(excerptActions(false), ["new-user-story", "new-chat"])
})

test("a code excerpt card shows the file and its lines", () => {
  assert.deepEqual(
    excerptCard({ content: "x", endLine: 4, path: "src/a.ts", startLine: 2 }),
    {
      fileName: "src/a.ts",
      mimeType: "text/plain",
      subtitle: "Lines 2-4",
      title: "src/a.ts",
    }
  )
})

test("a message excerpt card shows its author without line numbers", () => {
  const excerpt = messageExcerpt({ author: "agent", text: "Done." })
  assert.ok(excerpt)
  assert.deepEqual(excerptCard(excerpt), {
    fileName: "agent-message.md",
    mimeType: "text/markdown",
    subtitle: undefined,
    title: "Agent message",
  })
})

test("a queue hands its excerpts over once, in order", () => {
  const queue = createExcerptQueue<{ id: string }>()
  assert.deepEqual(queue.take(), [])
  queue.push({ id: "first" })
  queue.push({ id: "second" })
  assert.deepEqual(queue.take(), [{ id: "first" }, { id: "second" }])
  assert.deepEqual(queue.take(), [])
})
