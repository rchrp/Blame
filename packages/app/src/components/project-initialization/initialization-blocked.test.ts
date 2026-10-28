import assert from "node:assert/strict"
import test from "node:test"

import { blockedInitialization } from "./initialization-blocked.ts"

test("reads a block from the error the app saved", () => {
  const blocked = blockedInitialization(
    "Error invoking remote method 'agent:initializations:run': Error: Initialization blocked [missing_secret]: The app needs a Stripe key to start.\nWhat you can do: Add STRIPE_SECRET_KEY to .env.example.\nEvidence: src/stripe.ts throws without it."
  )
  assert.deepEqual(blocked, {
    category: "missing_secret",
    title: "A secret is missing",
    summary: "The app needs a Stripe key to start.",
    userAction: "Add STRIPE_SECRET_KEY to .env.example.",
    evidence: "src/stripe.ts throws without it.",
  })
})

test("ignores other errors", () => {
  assert.equal(blockedInitialization("Model quota exceeded"), undefined)
  assert.equal(blockedInitialization(null), undefined)
})
