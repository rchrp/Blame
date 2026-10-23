import assert from "node:assert/strict"
import test from "node:test"

import { previewUpdateMessage } from "./preview-update-notice.ts"

test("announces the files a cloud sync brought in", () => {
  const before = { syncSequence: 2, changedFiles: 1, agentRunning: true }
  assert.equal(
    previewUpdateMessage(before, {
      ...before,
      syncSequence: 3,
      changedFiles: 4,
    }),
    "4 files updated"
  )
  assert.equal(
    previewUpdateMessage(before, {
      ...before,
      syncSequence: 3,
      changedFiles: 1,
    }),
    "1 file updated"
  )
  assert.equal(previewUpdateMessage(before, before), undefined)
})

test("announces the end of an agent run for previews of the worktree", () => {
  assert.equal(
    previewUpdateMessage({ agentRunning: true }, { agentRunning: false }),
    "Agent changes applied"
  )
  assert.equal(
    previewUpdateMessage({ agentRunning: false }, { agentRunning: false }),
    undefined
  )
})
