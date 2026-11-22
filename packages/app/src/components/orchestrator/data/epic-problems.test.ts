import assert from "node:assert/strict"
import test from "node:test"

import { epicProblems } from "./epic-problems.ts"

test("every problem shows, each with what the person can do", () => {
  const notices = epicProblems({
    conversation: "failed",
    error: "The model refused the request.",
    problems: [
      { kind: "turn", message: "The model refused the request." },
      { kind: "branch", message: "The epic's branch epic/x is gone." },
    ],
  })
  assert.deepEqual(
    notices.map((notice) => notice.kind),
    ["turn", "branch"]
  )
  assert.ok(notices.every((notice) => notice.action.length > 0))
})

test("a host without problems: its one sentence, by the state it came with", () => {
  assert.equal(
    epicProblems({ conversation: "failed", error: "Boom." })[0]?.kind,
    "turn"
  )
  assert.equal(
    epicProblems({ conversation: "waiting", error: "A wake failed." })[0]?.kind,
    "wake"
  )
  assert.deepEqual(epicProblems({ conversation: "waiting" }), [])
  assert.deepEqual(epicProblems(undefined), [])
})
