import assert from "node:assert/strict"
import test from "node:test"

import { createProviderListCache } from "./provider-list-cache.ts"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

test("pickers asking at the same time share one request", async () => {
  const storage = memoryStorage()
  const cache = createProviderListCache<string>({ storage: () => storage })
  let calls = 0
  const fetch = async () => `list ${++calls}`
  const [first, second] = await Promise.all([
    cache.load("user", fetch),
    cache.load("user", fetch),
  ])
  assert.equal(calls, 1)
  assert.equal(first, second)
  assert.equal(cache.read("user"), "list 1")
})

test("a recent list is reused, a forced or stale one is fetched again", async () => {
  let time = 0
  const storage = memoryStorage()
  const cache = createProviderListCache<number>({
    now: () => time,
    storage: () => storage,
  })
  let calls = 0
  const fetch = async () => ++calls
  await cache.load("user", fetch)
  time = 10_000
  assert.equal(await cache.load("user", fetch), 1)
  assert.equal(await cache.load("user", fetch, { force: true }), 2)
  time = 100_000
  assert.equal(await cache.load("user", fetch), 3)
})

test("the last session's list shows at once and is refreshed", async () => {
  const storage = memoryStorage()
  const previous = createProviderListCache<string>({ storage: () => storage })
  await previous.load("user", async () => "yesterday")
  const cache = createProviderListCache<string>({ storage: () => storage })
  assert.equal(cache.read("user"), "yesterday")
  assert.equal(cache.read("someone else"), undefined)
  assert.equal(await cache.load("user", async () => "today"), "today")
})
