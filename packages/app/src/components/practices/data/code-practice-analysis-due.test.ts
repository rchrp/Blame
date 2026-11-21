import assert from "node:assert/strict"
import test from "node:test"

import {
  codePracticeAnalysisDue,
  failedCodePracticeAnalysisRetryMs,
  staleCodePracticeAnalysisMs,
} from "./code-practice-analysis-due.ts"

const now = Date.parse("2026-11-05T12:00:00.000Z")
const at = (offsetMs: number) => new Date(now - offsetMs).toISOString()
const opus = { providerId: "claude-code", modelId: "claude-opus-5" }
const luna = { providerId: "chatgpt", modelId: "gpt-6-luna" }
const analysis = (
  status: string,
  updatedAt: string | null,
  error: string | null = null
) =>
  ({
    agentModelId: opus.modelId,
    agentProviderId: opus.providerId,
    createdAt: at(staleCodePracticeAnalysisMs * 2),
    error,
    status,
    updatedAt,
  }) as never
const due = (value: never, runningHere = false, model = opus) =>
  codePracticeAnalysisDue(value, runningHere, model, now)

// The task's failure as the app saves it: the engine's words for Claude
// Code's 429, and when the plan resets.
const usedUp = (resetsAt?: string) =>
  "Error invoking remote method 'engine:call': Error: The code practice analyzer could not run: " +
  "Your Claude Code usage for `claude-opus-5` is used up until it resets: " +
  '"You\'ve hit your session limit · resets 1:10am (Europe/Bucharest)". Choose another model, or wait for the reset.' +
  (resetsAt ? ` It resets at ${resetsAt}.` : "")

test("analyzes a project never analyzed", () => {
  assert.equal(due(analysis("pending", null)), true)
})

test("a failed analysis waits before running again with the same model", () => {
  assert.equal(due(analysis("error", at(1_000), "boom")), false)
  assert.equal(
    due(analysis("error", at(failedCodePracticeAnalysisRetryMs), "boom")),
    true
  )
  assert.equal(
    due(analysis("error", at(1_000), "boom"), false, luna),
    true,
    "another model runs at once"
  )
})

test("a used-up plan waits for its reset or another model", () => {
  const later = new Date(now + 60_000).toISOString()
  const earlier = new Date(now - 60_000).toISOString()
  assert.equal(
    due(
      analysis(
        "error",
        at(failedCodePracticeAnalysisRetryMs * 2),
        usedUp(later)
      )
    ),
    false
  )
  assert.equal(
    due(
      analysis(
        "error",
        at(failedCodePracticeAnalysisRetryMs * 2),
        usedUp(earlier)
      )
    ),
    true
  )
  assert.equal(
    due(analysis("error", at(1_000), usedUp(later)), false, luna),
    true
  )
  // No stated reset: one try an hour.
  assert.equal(due(analysis("error", at(30 * 60_000), usedUp())), false)
  assert.equal(due(analysis("error", at(60 * 60_000), usedUp())), true)
})

test("leaves a finished analysis and one running in this window alone", () => {
  assert.equal(due(analysis("done", at(1_000))), false)
  assert.equal(due(analysis("pending", null), true), false)
})

test("reruns an analysis left running by an app that quit", () => {
  assert.equal(due(analysis("running", at(60_000))), false)
  assert.equal(
    due(analysis("running", at(staleCodePracticeAnalysisMs + 1))),
    true
  )
})
