import assert from "node:assert/strict"
import test from "node:test"

import {
  mergeUserStoryDiffStats,
  totalDiffStats,
} from "./development-diff-stats-data.ts"

test("totals additions and deletions across changed files", () => {
  assert.deepEqual(
    totalDiffStats([
      { additions: 12, deletions: 3 },
      { additions: 4 },
      { deletions: 8 },
    ]),
    { additions: 16, deletions: 11, files: 3 }
  )
})

test("returns empty stats when the diff has no files", () => {
  assert.deepEqual(totalDiffStats([]), {
    additions: 0,
    deletions: 0,
    files: 0,
  })
})

test("a story whose diff could not be read keeps its last numbers", () => {
  const shown = { additions: 12, deletions: 3, files: 2 }
  const current = new Map([
    ["US-1", shown],
    ["US-2", { additions: 1, deletions: 0, files: 1 }],
  ])
  const next = mergeUserStoryDiffStats(
    current,
    [{ id: "US-1" }, { id: "US-3" }],
    [
      { id: "US-1" },
      { id: "US-3", stats: { additions: 4, deletions: 0, files: 1 } },
    ]
  )
  assert.deepEqual(next.get("US-1"), shown)
  assert.equal(next.has("US-2"), false)
  assert.deepEqual(next.get("US-3"), { additions: 4, deletions: 0, files: 1 })
})
