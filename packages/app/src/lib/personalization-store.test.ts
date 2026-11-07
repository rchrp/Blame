import assert from "node:assert/strict"
import test from "node:test"

import { createPersonalizationStore } from "./personalization-store.ts"
import { defaultPersonalization } from "./personalization.ts"

const saves = () => {
  const saved: unknown[] = []
  return {
    saved,
    save: (value: unknown) => {
      saved.push(value)
      return Promise.resolve()
    },
  }
}

test("starts on the default notches", () => {
  assert.deepEqual(createPersonalizationStore().get(), defaultPersonalization)
})

test("a change made in the menu shows at once in Settings, and the reverse", async () => {
  const store = createPersonalizationStore()
  const menu: unknown[] = []
  const settings: unknown[] = []
  store.subscribe(() => menu.push(store.get().autonomy))
  store.subscribe(() => settings.push(store.get().autonomy))
  const { save, saved } = saves()

  const pending = store.change("autonomy", "decide", save)
  assert.deepEqual(menu, ["decide"])
  assert.deepEqual(settings, ["decide"])
  await pending
  await store.change("autonomy", "ask", save)

  assert.deepEqual(settings, ["decide", "ask"])
  assert.deepEqual(saved, [
    { ...defaultPersonalization, autonomy: "decide" },
    { ...defaultPersonalization, autonomy: "ask" },
  ])
})

test("saves the whole set of settings and leaves the others alone", async () => {
  const store = createPersonalizationStore({
    ...defaultPersonalization,
    experience: "new",
  })
  const { save, saved } = saves()
  await store.change("responseStyle", "concise", save)
  assert.deepEqual(saved, [
    { ...defaultPersonalization, experience: "new", responseStyle: "concise" },
  ])
})

test("saves nothing when the notch does not change", async () => {
  const store = createPersonalizationStore()
  const { save, saved } = saves()
  await store.change("ambition", "standard", save)
  assert.deepEqual(saved, [])
})

test("goes back to what the account holds when the save fails", async () => {
  const store = createPersonalizationStore()
  const seen: string[] = []
  store.subscribe(() => seen.push(store.get().ambition))

  await assert.rejects(
    store.change("ambition", "ambitious", () =>
      Promise.reject(new Error("offline"))
    ),
    /offline/
  )

  assert.deepEqual(seen, ["ambitious", "standard"])
  assert.equal(store.get().ambition, "standard")
})

test("takes the account's settings, but not over a change still being saved", async () => {
  const store = createPersonalizationStore()
  let finish = () => {}
  const slow = () => new Promise<void>((resolve) => (finish = resolve))

  const pending = store.change("autonomy", "decide", slow)
  store.hydrate({ ...defaultPersonalization, autonomy: "ask" })
  assert.equal(store.get().autonomy, "decide")

  finish()
  await pending
  store.hydrate({ ...defaultPersonalization, autonomy: "decide" })
  assert.equal(store.get().autonomy, "decide")

  store.hydrate({ ...defaultPersonalization, autonomy: "ask" })
  assert.equal(store.get().autonomy, "ask")
})

test("only the latest of two quick changes goes back when it fails", async () => {
  const store = createPersonalizationStore()
  const ok = () => Promise.resolve()
  const fails = () => Promise.reject(new Error("no"))

  const first = store.change("experience", "new", fails)
  const second = store.change("experience", "experienced", ok)
  await assert.rejects(first)
  await second

  assert.equal(store.get().experience, "experienced")
})

test("stops telling a listener that unsubscribed", async () => {
  const store = createPersonalizationStore()
  let calls = 0
  const unsubscribe = store.subscribe(() => (calls += 1))
  await store.change("autonomy", "ask", () => Promise.resolve())
  unsubscribe()
  await store.change("autonomy", "decide", () => Promise.resolve())
  assert.equal(calls, 1)
})
