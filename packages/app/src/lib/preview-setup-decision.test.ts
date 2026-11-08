import assert from "node:assert/strict"
import test from "node:test"

import {
  isPreviewSetupPolicy,
  previewSetupDecision,
} from "./preview-setup-decision.ts"

const base = { needsSetup: true, declinedThisSession: false } as const

test("asks before the first setup by default", () => {
  assert.equal(previewSetupDecision({ ...base, policy: "ask" }), "ask")
})

test("sets up right away when the person chose automatic setup", () => {
  assert.equal(previewSetupDecision({ ...base, policy: "automatic" }), "run")
})

test("leaves the project alone when the person chose never", () => {
  assert.equal(previewSetupDecision({ ...base, policy: "never" }), "skip")
})

test("does nothing for a project that already has a setup", () => {
  for (const policy of ["ask", "automatic", "never"] as const) {
    assert.equal(
      previewSetupDecision({ ...base, needsSetup: false, policy }),
      "skip"
    )
  }
})

test("does not ask again after Not now during the session", () => {
  assert.equal(
    previewSetupDecision({ ...base, policy: "ask", declinedThisSession: true }),
    "skip"
  )
})

test("a remembered automatic setup wins over a session decline", () => {
  assert.equal(
    previewSetupDecision({
      ...base,
      policy: "automatic",
      declinedThisSession: true,
    }),
    "run"
  )
})

test("recognizes only the three policies", () => {
  assert.equal(isPreviewSetupPolicy("ask"), true)
  assert.equal(isPreviewSetupPolicy("automatic"), true)
  assert.equal(isPreviewSetupPolicy("never"), true)
  assert.equal(isPreviewSetupPolicy("always"), false)
  assert.equal(isPreviewSetupPolicy(undefined), false)
})
