import assert from "node:assert/strict"
import test from "node:test"

import { readableReasoning } from "./reasoning-text.ts"

test("separates reasoning parts that arrive glued together", () => {
  assert.equal(
    readableReasoning(
      "**Reading the code**\n\nI checked the file.**Planning the fix**I will update it."
    ),
    "**Reading the code**\n\nI checked the file.\n\n**Planning the fix**\n\nI will update it."
  )
})

test("adds the missing space between glued sentences", () => {
  assert.equal(
    readableReasoning("The tests pass.Next I run the linter."),
    "The tests pass. Next I run the linter."
  )
})

test("leaves regular prose, inline bold and code alone", () => {
  const text = [
    "Use **bold** words and **Note**: a label.",
    "Open `App.Tsx` and `a.**B**`.",
    "```ts",
    "const value = foo.Bar.**Baz**",
    "```",
  ].join("\n")
  assert.equal(readableReasoning(text), text)
})
