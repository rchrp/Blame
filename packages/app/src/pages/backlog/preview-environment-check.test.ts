import assert from "node:assert/strict"
import test from "node:test"

import { previewEnvironmentCheckBase } from "./preview-environment-check.ts"

const history = [
  { hash: "c3", date: "2026-10-16T23:58:38+03:00" },
  { hash: "c2", date: "2026-10-16T03:23:47+03:00" },
  { hash: "c1", date: "2026-09-12T23:46:20+02:00" },
]

test("compares the branch with the commit last checked", () => {
  assert.equal(
    previewEnvironmentCheckBase(history, {
      checkedCommit: "c2",
      updatedAt: "2026-09-20T10:00:00Z",
    }),
    "c2"
  )
})

test("has nothing to compare once the head was checked", () => {
  assert.equal(
    previewEnvironmentCheckBase(history, {
      checkedCommit: "c3",
      updatedAt: null,
    }),
    undefined
  )
})

test("falls back to the last save without a commit on the branch", () => {
  const savedAt = "2026-09-20T10:00:00Z"
  assert.equal(
    previewEnvironmentCheckBase(history, {
      checkedCommit: null,
      updatedAt: savedAt,
    }),
    "c1"
  )
  assert.equal(
    previewEnvironmentCheckBase(history, {
      checkedCommit: "rewritten",
      updatedAt: savedAt,
    }),
    "c1"
  )
  assert.equal(
    previewEnvironmentCheckBase(history, {
      checkedCommit: null,
      updatedAt: "2026-10-20T00:00:00Z",
    }),
    undefined
  )
})

test("has nothing to compare without a usable history or date", () => {
  const environment = { checkedCommit: null, updatedAt: "2026-01-01T00:00:00Z" }
  assert.equal(previewEnvironmentCheckBase(history, environment), undefined)
  assert.equal(previewEnvironmentCheckBase([], environment), undefined)
  assert.equal(
    previewEnvironmentCheckBase(history, {
      checkedCommit: null,
      updatedAt: "not a date",
    }),
    undefined
  )
})
