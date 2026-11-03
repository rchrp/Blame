import assert from "node:assert/strict"
import test from "node:test"

import {
  hostedServiceAccess,
  hostedServiceRequirement,
} from "./hosted-service-access.ts"

const license = (licensed: boolean) => ({
  licensed,
  status: licensed ? "active" : "inactive",
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
})

test("asks a local workspace for an account, and names Blame Cloud as the step", () => {
  const local = { mode: "local" as const }
  assert.equal(hostedServiceAccess(local, "cloud-preview"), "account-required")
  assert.equal(
    hostedServiceRequirement(local, "voice-transcription"),
    "Cloud voice transcription requires Blame Cloud"
  )
})

test("asks an account for Premium, and opens hosted services to Premium", () => {
  const free = { mode: "account" as const, license: license(false) }
  const premium = { mode: "account" as const, license: license(true) }
  assert.equal(hostedServiceAccess(free, "cloud-preview"), "premium-required")
  assert.equal(
    hostedServiceRequirement(free, "cloud-preview"),
    "Cloud Previews require Blame Cloud"
  )
  assert.equal(hostedServiceAccess(premium, "deployment"), "available")
})
