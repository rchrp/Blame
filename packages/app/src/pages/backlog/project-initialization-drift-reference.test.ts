import assert from "node:assert/strict"
import test from "node:test"

import { initializationDriftRange } from "./project-initialization-drift-reference.ts"

const history = [
  { hash: "c3", date: "2026-10-16T23:58:38+03:00" },
  { hash: "c2", date: "2026-10-16T03:23:47+03:00" },
  { hash: "c1", date: "2026-09-12T23:46:20+02:00" },
]

test("compares the project with the commit the setup was saved against", () => {
  assert.deepEqual(initializationDriftRange(history, "2026-09-20T10:00:00Z"), {
    baseCommit: "c1",
    mergeCommit: "c3",
  })
})

test("reports no drift when nothing was committed since the save", () => {
  assert.equal(
    initializationDriftRange(history, "2026-10-20T00:00:00Z"),
    undefined
  )
})

test("reports no drift without a usable history or date", () => {
  assert.equal(
    initializationDriftRange(history, "2026-01-01T00:00:00Z"),
    undefined
  )
  assert.equal(initializationDriftRange([], "2026-09-20T10:00:00Z"), undefined)
  assert.equal(initializationDriftRange(history, "not a date"), undefined)
})
