import assert from "node:assert/strict"
import test from "node:test"

import {
  codePracticeAnalysisDue,
  staleCodePracticeAnalysisMs,
} from "./code-practice-analysis-due.ts"

const now = Date.parse("2026-11-05T12:00:00.000Z")
const at = (offsetMs: number) => new Date(now - offsetMs).toISOString()
const analysis = (status: string, updatedAt: string | null) =>
  ({
    createdAt: at(staleCodePracticeAnalysisMs * 2),
    status,
    updatedAt,
  }) as never

test("analyzes a project never analyzed or whose analysis failed", () => {
  assert.equal(
    codePracticeAnalysisDue(analysis("pending", null), false, now),
    true
  )
  assert.equal(
    codePracticeAnalysisDue(analysis("error", at(1_000)), false, now),
    true
  )
})

test("leaves a finished analysis and one running in this window alone", () => {
  assert.equal(
    codePracticeAnalysisDue(analysis("done", at(1_000)), false, now),
    false
  )
  assert.equal(
    codePracticeAnalysisDue(analysis("pending", null), true, now),
    false
  )
})

test("reruns an analysis left running by an app that quit", () => {
  assert.equal(
    codePracticeAnalysisDue(analysis("running", at(60_000)), false, now),
    false
  )
  assert.equal(
    codePracticeAnalysisDue(
      analysis("running", at(staleCodePracticeAnalysisMs + 1)),
      false,
      now
    ),
    true
  )
})
