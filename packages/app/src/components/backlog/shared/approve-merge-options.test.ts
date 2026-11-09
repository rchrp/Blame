import assert from "node:assert/strict"
import test from "node:test"

import { approveMergeOptions } from "./approve-merge-options.ts"

test("Approve & Merge does not push", () => {
  assert.deepEqual(approveMergeOptions("Approve & Merge"), { push: false })
})

test("Approve, Merge & Push pushes", () => {
  assert.deepEqual(approveMergeOptions("Approve, Merge & Push"), { push: true })
})
