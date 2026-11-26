import assert from "node:assert/strict"
import test from "node:test"

import { defaultConnectionLabel } from "./connection-label.ts"

test("the first connection of a provider is number 1", () => {
  assert.equal(defaultConnectionLabel("OpenAI", []), "OpenAI 1")
})

test("the next free number follows the existing connections", () => {
  assert.equal(defaultConnectionLabel("OpenAI", ["OpenAI 1"]), "OpenAI 2")
  assert.equal(
    defaultConnectionLabel("OpenAI", ["Work", "Personal"]),
    "OpenAI 1"
  )
})

test("a gap is reused, whatever the case or spacing of the taken names", () => {
  assert.equal(
    defaultConnectionLabel("Anthropic", ["anthropic 1", " Anthropic 3 "]),
    "Anthropic 2"
  )
})
