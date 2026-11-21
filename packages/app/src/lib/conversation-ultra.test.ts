import assert from "node:assert/strict"
import test from "node:test"

import {
  chatUltraKey,
  createConversationUltraStore,
  newChatUltraKey,
  storyUltraKey,
  type UltraStorage,
} from "./conversation-ultra.ts"

function memory(initial?: string): UltraStorage & { saved?: string } {
  const storage: UltraStorage & { saved?: string } = {
    getItem: () => storage.saved ?? initial ?? null,
    setItem: (_key, value) => {
      storage.saved = value
    },
  }
  return storage
}

test("ultra mode is off until it is checked, and stays as set per conversation", () => {
  const store = createConversationUltraStore(memory())
  assert.equal(store.get(storyUltraKey("a")), false)
  store.set(storyUltraKey("a"), true)
  assert.equal(store.get(storyUltraKey("a")), true)
  assert.equal(store.get(storyUltraKey("b")), false, "another story")
  assert.equal(store.get(chatUltraKey("a")), false, "a chat is not a story")
  store.set(storyUltraKey("a"), false)
  assert.equal(store.get(storyUltraKey("a")), false)
})

test("the choice survives a restart", () => {
  const storage = memory()
  createConversationUltraStore(storage).set(chatUltraKey("c1"), true)
  const reopened = createConversationUltraStore(storage)
  assert.equal(reopened.get(chatUltraKey("c1")), true)
})

test("a new chat keeps its choice when its first message gives it an identity", () => {
  const store = createConversationUltraStore(memory())
  store.set(newChatUltraKey, true)
  store.move(newChatUltraKey, chatUltraKey("c2"))
  assert.equal(store.get(chatUltraKey("c2")), true)
  assert.equal(
    store.get(newChatUltraKey),
    false,
    "the next new chat starts off"
  )
})

test("listeners hear a change once, and not a repeat of the same value", () => {
  const store = createConversationUltraStore(memory())
  let heard = 0
  const stop = store.subscribe(() => heard++)
  store.set("x", true)
  store.set("x", true)
  assert.equal(heard, 1)
  stop()
  store.set("x", false)
  assert.equal(heard, 1)
})

test("unreadable storage means off, and writing may fail", () => {
  const broken: UltraStorage = {
    getItem: () => "not json",
    setItem: () => {
      throw new Error("full")
    },
  }
  const store = createConversationUltraStore(broken)
  assert.equal(store.get("x"), false)
  store.set("x", true)
  assert.equal(store.get("x"), true, "it holds until the app closes")
})
