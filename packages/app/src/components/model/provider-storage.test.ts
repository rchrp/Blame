import assert from "node:assert/strict"
import test from "node:test"

import {
  defaultStorage,
  movesTo,
  storageCopy,
  storageToSend,
} from "./provider-storage.ts"

test("a new key stays on this device when there is a keychain", () => {
  assert.equal(
    defaultStorage({ accountMode: true, keychain: true }),
    "device"
  )
  assert.equal(
    defaultStorage({ accountMode: true, keychain: undefined }),
    "device"
  )
})

test("without a keychain the account is the only place", () => {
  assert.equal(
    defaultStorage({ accountMode: true, keychain: false }),
    "account"
  )
})

test("an existing credential keeps its place", () => {
  assert.equal(
    defaultStorage({ accountMode: true, keychain: true, existing: "account" }),
    "account"
  )
  assert.equal(
    defaultStorage({ accountMode: true, keychain: true, existing: "device" }),
    "device"
  )
})

test("without an account there is no choice and nothing is sent", () => {
  assert.equal(
    defaultStorage({ accountMode: false, keychain: true }),
    "account"
  )
  assert.equal(storageToSend("device", false), undefined)
  assert.equal(storageToSend("device", true), "device")
  assert.equal(movesTo("account", "device", false), false)
})

test("moving is a change of place, an old credential counts as the account's", () => {
  assert.equal(movesTo(undefined, "device", true), true)
  assert.equal(movesTo(undefined, "account", true), false)
  assert.equal(movesTo("device", "account", true), true)
  assert.equal(movesTo("device", "device", true), false)
})

test("the labels say what the person gets, in plain words", () => {
  const copy = storageCopy("key")
  assert.match(copy.accountLabel, /Save to my Blame account/)
  assert.match(copy.accountLabel, /other devices/)
  assert.equal(copy.deviceLabel, "Keep on this device only")
  assert.match(copy.deviceHint, /never sent to Blame/)
  assert.match(storageCopy("sign-in").deviceHint, /sign-in/)
})
