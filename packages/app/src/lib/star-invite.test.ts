import assert from "node:assert/strict"
import test from "node:test"

import {
  claimStarInvite,
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
