import assert from "node:assert/strict"
import test from "node:test"

import {
  agentPersonalization,
  ambitionOverride,
  defaultPersonalization,
  effectiveAmbition,
  normalizePersonalization,
  notchAt,
  notchIndex,
  parseNotch,
  personalizationDefinitions,
  personalizationOrder,
} from "./personalization.ts"

test("every setting has three notches and rests on the middle one by default", () => {
  for (const setting of personalizationOrder) {
    const { notches } = personalizationDefinitions[setting]
    assert.equal(notches.length, 3)
    assert.equal(notches[1].value, defaultPersonalization[setting])
    assert.equal(notchIndex(setting, defaultPersonalization[setting]), 1)
    for (const notch of notches) assert.ok(notch.description.length > 0)
  }
})

test("names the notches and gives each setting its color", () => {
  const labels = (setting: (typeof personalizationOrder)[number]) =>
    personalizationDefinitions[setting].notches.map(({ label }) => label)
  assert.deepEqual(labels("responseStyle"), ["Concise", "Balanced", "Detailed"])
  assert.deepEqual(labels("experience"), [
    "New to coding",
    "Comfortable",
    "Experienced",
  ])
  assert.deepEqual(labels("autonomy"), [
    "Ask first",
    "Balanced",
    "Decide and report",
  ])
  assert.deepEqual(labels("ambition"), ["Quick", "Standard", "Ambitious"])
  assert.deepEqual(
    personalizationOrder.map((setting) => personalizationDefinitions[setting].color),
    ["green", "violet", "amber", "rose"]
  )
})

test("describes each notch with its own sentence", () => {
  for (const setting of personalizationOrder) {
    const sentences = personalizationDefinitions[setting].notches.map(
      ({ description }) => description
    )
    assert.equal(new Set(sentences).size, 3)
  }
  assert.notEqual(
    notchAt("autonomy", 0).description,
    notchAt("autonomy", 2).description
  )
})

test("reads a value back to its notch", () => {
  assert.equal(parseNotch("autonomy", "decide"), "decide")
  assert.equal(parseNotch("autonomy", "reckless"), undefined)
  assert.equal(parseNotch("ambition", "decide"), undefined)
  assert.equal(notchIndex("ambition", "ambitious"), 2)
  assert.equal(notchIndex("ambition", "unknown"), 0)
  assert.equal(notchAt("ambition", 9).value, "ambitious")
  assert.equal(notchAt("ambition", -3).value, "quick")
})

test("falls back to the default notch for anything unknown", () => {
  assert.deepEqual(normalizePersonalization(undefined), defaultPersonalization)
  assert.deepEqual(normalizePersonalization("concise"), defaultPersonalization)
  assert.deepEqual(
    normalizePersonalization({
      responseStyle: "detailed",
      experience: "expert",
      autonomy: "decide",
    }),
    { ...defaultPersonalization, responseStyle: "detailed", autonomy: "decide" }
  )
})

test("an ambition of its own wins over the account's, and no ambition follows it", () => {
  assert.equal(effectiveAmbition("standard", "ambitious"), "ambitious")
  assert.equal(effectiveAmbition("quick", null), "quick")
  assert.equal(effectiveAmbition("quick", undefined), "quick")
})

test("choosing the account's ambition goes back to following it", () => {
  assert.equal(ambitionOverride("standard", "standard"), null)
  assert.equal(ambitionOverride("standard", "quick"), "quick")
  assert.equal(ambitionOverride("ambitious", "standard"), "standard")
})

test("tells the agent the account's settings with the ambition of the story", () => {
  const account = {
    ...defaultPersonalization,
    experience: "new" as const,
    ambition: "quick" as const,
  }
  assert.deepEqual(agentPersonalization(account, "ambitious"), {
    ...account,
    ambition: "ambitious",
  })
  assert.deepEqual(agentPersonalization(account, null), account)
  assert.deepEqual(agentPersonalization(account), account)
})
