import assert from "node:assert/strict"
import test from "node:test"

import { directQueueNotice, directStorySlots } from "./direct-story-queue.ts"

const story = (status: string, workspaceMode?: string) =>
  ({ status, workspaceMode }) as never

test("starts one Direct story when none is active", () => {
  assert.equal(directStorySlots([story("ready"), story("done", "direct")], 0), 1)
})

test("waits while a Direct story runs, waits for review, or is starting", () => {
  assert.equal(directStorySlots([story("in-progress", "direct")], 0), 0)
  assert.equal(directStorySlots([story("in-review", "direct")], 0), 0)
  assert.equal(directStorySlots([], 1), 0)
})

test("ignores stories running in other modes", () => {
  assert.equal(directStorySlots([story("in-progress", "local-container")], 0), 1)
})

test("explains the wait only when something is queued", () => {
  assert.equal(directQueueNotice([story("in-review", "direct")]), undefined)
  assert.equal(
    directQueueNotice([story("in-review", "direct"), story("ready")]),
    "Waiting for the Direct story in review"
  )
})
