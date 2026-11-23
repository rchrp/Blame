import assert from "node:assert/strict"
import test from "node:test"

import {
  claimStarInvite,
  countQuickChatMessage,
  quickChatCountStorageKey,
  starInviteQuickChatMessages,
  starInviteDue,
  starInviteStorageKey,
} from "./star-invite.ts"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

function failing() {
  throw new Error("storage unavailable")
}

test("the first merge shows the invitation and records it", () => {
  const storage = memoryStorage()
  assert.equal(starInviteDue("merged", storage), true)
  assert.equal(
    claimStarInvite(storage, new Date("2026-11-03T10:00:00.000Z")),
    true
  )
  assert.deepEqual(JSON.parse(storage.values.get(starInviteStorageKey)!), {
    shownAt: "2026-11-03T10:00:00.000Z",
  })
})

test("the flag stops a second invitation", () => {
  const storage = memoryStorage()
  assert.equal(claimStarInvite(storage), true)
  assert.equal(starInviteDue("merged", storage), false)
  assert.equal(claimStarInvite(storage), false)
})

test("any stored value counts as already shown", () => {
  const storage = memoryStorage()
  storage.setItem(starInviteStorageKey, "not json")
  assert.equal(starInviteDue("merged", storage), false)
  assert.equal(claimStarInvite(storage), false)
})

test("a failed merge doesn't show it", () => {
  const storage = memoryStorage()
  assert.equal(starInviteDue("failed", storage), false)
  assert.equal(storage.values.size, 0)
})

test("storage that can't be read fails closed", () => {
  const storage = { getItem: failing, setItem: failing }
  assert.equal(starInviteDue("merged", storage), false)
  assert.equal(claimStarInvite(storage), false)
  assert.equal(starInviteDue("merged", undefined), false)
  assert.equal(claimStarInvite(undefined), false)
})

test("storage that can't be written fails closed", () => {
  const storage = { getItem: () => null, setItem: failing }
  assert.equal(starInviteDue("merged", storage), true)
  assert.equal(claimStarInvite(storage), false)
})

test("the 3rd Quick Chat message makes the invitation due, not before", () => {
  const storage = memoryStorage()
  assert.equal(starInviteQuickChatMessages, 3)
  assert.equal(countQuickChatMessage(storage), false)
  assert.equal(countQuickChatMessage(storage), false)
  assert.equal(countQuickChatMessage(storage), true)
  assert.equal(storage.values.get(quickChatCountStorageKey), "3")
})

test("the count stays due until the invitation is shown", () => {
  const storage = memoryStorage()
  for (let i = 0; i < 3; i++) countQuickChatMessage(storage)
  assert.equal(countQuickChatMessage(storage), true)
})

test("nothing is counted once the invitation was shown", () => {
  const storage = memoryStorage()
  countQuickChatMessage(storage)
  assert.equal(claimStarInvite(storage), true)
  assert.equal(countQuickChatMessage(storage), false)
  assert.equal(storage.values.get(quickChatCountStorageKey), "1")
})

test("a merge first closes the Quick Chat trigger", () => {
  const storage = memoryStorage()
  assert.equal(claimStarInvite(storage), true)
  for (let i = 0; i < 5; i++) assert.equal(countQuickChatMessage(storage), false)
})

test("Quick Chat first closes the merge trigger", () => {
  const storage = memoryStorage()
  for (let i = 0; i < 3; i++) countQuickChatMessage(storage)
  assert.equal(claimStarInvite(storage), true)
  assert.equal(starInviteDue("merged", storage), false)
  assert.equal(claimStarInvite(storage), false)
})

test("a garbled count starts again", () => {
  const storage = memoryStorage()
  storage.setItem(quickChatCountStorageKey, "many")
  assert.equal(countQuickChatMessage(storage), false)
  assert.equal(storage.values.get(quickChatCountStorageKey), "1")
})

test("Quick Chat counting fails closed without usable storage", () => {
  assert.equal(countQuickChatMessage(undefined), false)
  assert.equal(
    countQuickChatMessage({ getItem: failing, setItem: failing }),
    false
  )
  assert.equal(
    countQuickChatMessage({ getItem: () => null, setItem: failing }),
    false
  )
})
