import assert from "node:assert/strict"
import test from "node:test"

import {
  hostedServiceAccess,
  hostedServiceOffer,
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

test("opens voice input to anyone with their own OpenRouter key, account or not", () => {
  const local = { mode: "local" as const, ownSpeechKey: "set" as const }
  const free = {
    mode: "account" as const,
    license: license(false),
    ownSpeechKey: "set" as const,
  }
  assert.equal(hostedServiceAccess(local, "voice-transcription"), "available")
  assert.equal(hostedServiceAccess(free, "voice-transcription"), "available")
})

test("the own key opens voice input only, and only once saved", () => {
  const local = { mode: "local" as const, ownSpeechKey: "set" as const }
  assert.equal(hostedServiceAccess(local, "cloud-preview"), "account-required")
  assert.equal(hostedServiceAccess(local, "hosted-uploads"), "account-required")
  assert.equal(
    hostedServiceAccess(
      { mode: "local" as const, ownSpeechKey: "unset" as const },
      "voice-transcription"
    ),
    "account-required"
  )
})

test("offers the own key and Blame Cloud for voice input, without an account", () => {
  const offer = hostedServiceOffer(
    { mode: "local", ownSpeechKey: "unset" },
    "voice-transcription"
  )
  assert.equal(offer.ownKey, true)
  assert.equal(offer.message, "Voice input is not set up yet")
  assert.match(offer.description ?? "", /own OpenRouter key/)
  assert.match(offer.description ?? "", /free account/)
  assert.match(
    offer.description ?? "",
    /Everything else keeps working without one/
  )
})

test("does not mention an account to someone who has one", () => {
  const offer = hostedServiceOffer(
    { mode: "account", license: license(false), ownSpeechKey: "unset" },
    "voice-transcription"
  )
  assert.equal(offer.ownKey, true)
  assert.doesNotMatch(offer.description ?? "", /account|without one/)
})

test("keeps the Blame Cloud offer where the own key cannot be saved", () => {
  const offer = hostedServiceOffer({ mode: "local" }, "voice-transcription")
  assert.equal(offer.ownKey, false)
  assert.equal(offer.message, "Cloud voice transcription requires Blame Cloud.")
  assert.match(offer.description ?? "", /free account/)
  const other = hostedServiceOffer(
    { mode: "local", ownSpeechKey: "unset" },
    "cloud-preview"
  )
  assert.equal(other.ownKey, false)
  assert.equal(other.message, "Cloud Previews require Blame Cloud.")
})
