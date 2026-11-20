import assert from "node:assert/strict"
import test from "node:test"
import type { SessionRecord } from "@blame/engine-client"

import { initializationTaskProgress } from "./project-initialization-progress.ts"

let seq = 0
const record = (body: Record<string, unknown>) =>
  ({ seq: ++seq, at_ms: 0, ...body }) as unknown as SessionRecord

test("an analysis's records become the steps of its progress bar", () => {
  const step = initializationTaskProgress()
  const read = step(
    record({ type: "tool_call_started", call: "c1", name: "read_code" })
  )
  assert.equal(read?.label, "Reading project files")
  assert.ok(read!.percent > 10)

  const checking = step(
    record({
      type: "tool_call_started",
      call: "c2",
      name: "submit_project_initialization",
    })
  )
  assert.equal(checking?.label, "Checking the setup")
  assert.ok(checking!.percent > read!.percent)

  const fixing = step(
    record({
      type: "tool_call_finished",
      call: "c2",
      outcome: "failed",
      content: [
        {
          type: "text",
          text: "Submission 1 of 10 was rejected. 9 submissions are left.\nProblem:\n1. [must fix] The previewManifest must run detected database migrations.\nFix every problem above.",
        },
      ],
    })
  )
  assert.deepEqual(fixing, {
    percent: checking!.percent,
    label: "Fixing the setup · 2 of 10",
    detail: "The previewManifest must run detected database migrations.",
  })

  // A read during the correction still says the setup is being fixed.
  assert.equal(
    step(record({ type: "tool_call_started", call: "c3", name: "search_code" }))
      ?.label,
    "Fixing the setup"
  )
  // Other tools' results, and records with nothing to show, change nothing.
  assert.equal(
    step(
      record({
        type: "tool_call_finished",
        call: "c3",
        outcome: "failed",
        content: [],
      })
    ),
    undefined
  )
  assert.equal(step(record({ type: "turn_ended", outcome: {} })), undefined)
})

test("a result the engine refused says what was wrong", () => {
  const step = initializationTaskProgress()
  assert.deepEqual(
    step(
      record({
        type: "result_rejected",
        call: "c1",
        invalid: [],
        unmet: [{ kind: "call", tool: "read_code" }],
      })
    ),
    {
      percent: 10,
      label: "Fixing the setup",
      detail: "The project is read first.",
    }
  )
})
