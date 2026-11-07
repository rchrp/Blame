import assert from "node:assert/strict"
import test from "node:test"

import {
  chatAmbitionKey,
  createConversationAmbitionStore,
  newChatAmbitionKey,
  planModeAmbitionKey,
} from "./conversation-ambition.ts"

const memory = (initial?: string) => {
  const values = new Map<string, string>()
  if (initial) values.set("blame.conversation-ambition.v1", initial)
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

test("a conversation follows the account's ambition until one is chosen for it", () => {
  const store = createConversationAmbitionStore(memory())
  assert.equal(store.get(chatAmbitionKey("a")), null)
  store.set(chatAmbitionKey("a"), "ambitious")
  assert.equal(store.get(chatAmbitionKey("a")), "ambitious")
  assert.equal(store.get(chatAmbitionKey("b")), null)
})

test("going back to the default clears the choice", () => {
  const store = createConversationAmbitionStore(memory())
  store.set(planModeAmbitionKey("p"), "quick")
  store.set(planModeAmbitionKey("p"), null)
  assert.equal(store.get(planModeAmbitionKey("p")), null)
})

test("keeps the choice for the whole conversation, across restarts", () => {
  const storage = memory()
  createConversationAmbitionStore(storage).set("chat:a", "quick")
  assert.equal(createConversationAmbitionStore(storage).get("chat:a"), "quick")
})

test("ignores stored values it does not know", () => {
  const store = createConversationAmbitionStore(
    memory('{"chat:a":"reckless","chat:b":"quick","chat:c":3}')
  )
  assert.equal(store.get("chat:a"), null)
  assert.equal(store.get("chat:b"), "quick")
  assert.equal(store.get("chat:c"), null)
  assert.equal(createConversationAmbitionStore(memory("not json")).get("x"), null)
})

test("a new chat keeps its choice once it has an identity", () => {
  const store = createConversationAmbitionStore(memory())
  store.set(newChatAmbitionKey, "ambitious")
  store.move(newChatAmbitionKey, chatAmbitionKey("created"))
  assert.equal(store.get(chatAmbitionKey("created")), "ambitious")
  assert.equal(store.get(newChatAmbitionKey), null)
  store.move(newChatAmbitionKey, chatAmbitionKey("other"))
  assert.equal(store.get(chatAmbitionKey("other")), null)
})

test("tells the listeners when a choice changes, and only then", () => {
  const store = createConversationAmbitionStore(memory())
  let calls = 0
  store.subscribe(() => (calls += 1))
  store.set("chat:a", "quick")
  store.set("chat:a", "quick")
  store.set("chat:a", null)
  assert.equal(calls, 2)
})

test("works without any storage", () => {
  const store = createConversationAmbitionStore()
  store.set("chat:a", "quick")
  assert.equal(store.get("chat:a"), "quick")
})

test("gives the new chat and each chat their own key", () => {
  assert.equal(chatAmbitionKey(), newChatAmbitionKey)
  assert.notEqual(chatAmbitionKey("a"), chatAmbitionKey("b"))
  assert.notEqual(planModeAmbitionKey("p"), planModeAmbitionKey("q"))
})
