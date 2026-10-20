import assert from "node:assert/strict"
import test from "node:test"

import { storyDropActions } from "./story-drop-actions.ts"

const zones = (status: string, options = {}) =>
  storyDropActions({ id: "s1", status, workspaceMode: "local-container" } as never, options).map(
    (action) => [action.column, action.label, Boolean(action.confirm)]
  )

test("a story in review can be sent back, merged or discarded", () => {
  assert.deepEqual(zones("in-review"), [
    ["in-progress", "Request Changes", false],
    ["done", "Approve & Merge", false],
    ["discarded", "Reject and discard", true],
  ])
  assert.deepEqual(zones("in-review", { reviewDiffEmpty: true }), [
    ["in-progress", "Request Changes", false],
    ["done", "Mark as Done", false],
    ["discarded", "Discard", false],
  ])
})

test("each state offers only the moves its card buttons offer", () => {
  assert.deepEqual(zones("backlog"), [
    ["ready", "Send to Dev Agent", false],
    ["discarded", "Discard", false],
  ])
  assert.deepEqual(zones("ready"), [["backlog", "Dequeue", false]])
  assert.deepEqual(zones("in-progress"), [
    ["backlog", "Stop and move to backlog", false],
    ["discarded", "Stop and discard", true],
  ])
  assert.deepEqual(zones("done"), [["backlog", "New story with this context", false]])
  assert.deepEqual(zones("discarded"), [["backlog", "Rework", false]])
})

test("drop zones carry the same requests as the buttons", () => {
  const [, approve, discard] = storyDropActions({ id: "s1", status: "in-review" } as never)
  assert.deepEqual(approve?.request, { action: "Approve & Merge" })
  assert.deepEqual(discard?.request, { rejectChoice: "discard" })
})
