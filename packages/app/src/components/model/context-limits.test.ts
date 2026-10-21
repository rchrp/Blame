import assert from "node:assert/strict"
import test from "node:test"

import {
  contextLimitOptions,
  effectiveContextLimit,
  modelInputLimit,
  providerInputLimit,
} from "./context-limits.ts"

const codex = {
  contextWindow: 400_000,
  id: "gpt-6.1-sol",
  maxInputTokens: 258_400,
}
const api = {
  contextWindow: 1_050_000,
  id: "gpt-6.1-sol",
  maxInputTokens: 922_000,
}

test("uses the provider's input budget, or most of the window", () => {
  assert.equal(providerInputLimit(codex), 258_400)
  assert.equal(providerInputLimit({ contextWindow: 200_000, id: "m" }), 180_000)
  assert.equal(providerInputLimit({ id: "m" }), undefined)
})

test("lets a cap reach what the model takes through another provider", () => {
  const providers = [
    { models: { [codex.id]: codex } },
    { models: { [api.id]: api } },
  ]
  assert.equal(modelInputLimit(codex, providers), 922_000)
  assert.equal(modelInputLimit({ ...codex, id: "other" }, providers), 258_400)
})

test("offers smaller caps, the provider default, then experimental ones", () => {
  const options = contextLimitOptions(258_400, 922_000)
  assert.deepEqual(
    options.map((option) => [option.tokens, option.value, option.experimental]),
    [
      [32_000, 32_000, false],
      [64_000, 64_000, false],
      [128_000, 128_000, false],
      [200_000, 200_000, false],
      [258_400, undefined, false],
      [400_000, 400_000, true],
      [600_000, 600_000, true],
      [800_000, 800_000, true],
      [922_000, 922_000, true],
    ]
  )
  assert.equal(
    contextLimitOptions(922_000, 922_000).some((option) => option.experimental),
    false
  )
})

test("never sends more than the model takes", () => {
  assert.equal(effectiveContextLimit(undefined, 922_000), undefined)
  assert.equal(effectiveContextLimit(128_000, 922_000), 128_000)
  assert.equal(effectiveContextLimit(1_000_000, 922_000), 922_000)
})
