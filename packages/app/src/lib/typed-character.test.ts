import assert from "node:assert/strict"
import test from "node:test"

import { isTypedCharacter, type KeyDownFacts } from "./typed-character.ts"

function facts(overrides: Partial<KeyDownFacts>): KeyDownFacts {
  return {
    key: "a",
    ctrlKey: false,
    metaKey: false,
    altGraph: false,
    isComposing: false,
    targetActivatesOnSpace: false,
    ...overrides,
  }
}

test("printable characters are typed text, accented ones included", () => {
  for (const key of ["a", "D", "?", "/", "é", "ê", "1", "😀"]) {
    assert.equal(isTypedCharacter(facts({ key })), true, key)
  }
})

test("a dead key starts an accented character", () => {
  assert.equal(isTypedCharacter(facts({ key: "Dead" })), true)
})

test("navigation, editing and function keys are not typed text", () => {
  for (const key of [
    "ArrowDown",
    "Tab",
    "Escape",
    "Enter",
    "Backspace",
    "F5",
    "Shift",
    "Process",
  ]) {
    assert.equal(isTypedCharacter(facts({ key })), false, key)
  }
})

test("Ctrl and ⌘ combinations are shortcuts", () => {
  assert.equal(isTypedCharacter(facts({ ctrlKey: true })), false)
  assert.equal(isTypedCharacter(facts({ metaKey: true })), false)
})

test("AltGr characters are typed text", () => {
  assert.equal(
    isTypedCharacter(facts({ key: "@", ctrlKey: true, altGraph: true })),
    true
  )
})

test("a composition in progress is left alone", () => {
  assert.equal(isTypedCharacter(facts({ isComposing: true })), false)
})

test("Space activates a focused button instead of typing", () => {
  assert.equal(isTypedCharacter(facts({ key: " " })), true)
  assert.equal(
    isTypedCharacter(facts({ key: " ", targetActivatesOnSpace: true })),
    false
  )
  assert.equal(
    isTypedCharacter(facts({ key: "a", targetActivatesOnSpace: true })),
    true
  )
})
