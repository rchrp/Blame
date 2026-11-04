import assert from "node:assert/strict"
import test from "node:test"

import { shouldCloseDrawerAfterDelete } from "./drawer-delete.ts"

test("closes the drawer when it shows the deleted story", () => {
  assert.equal(shouldCloseDrawerAfterDelete("story-1", "story-1"), true)
})

test("leaves the drawer open when another story is deleted", () => {
  assert.equal(shouldCloseDrawerAfterDelete("story-1", "story-2"), false)
})

test("leaves the drawer alone when none is open", () => {
  assert.equal(shouldCloseDrawerAfterDelete(undefined, "story-1"), false)
})
