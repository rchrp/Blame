import assert from "node:assert/strict"
import test from "node:test"
import type { ProviderListResponse } from "@blame/agent-runtime"
import { createProviderCatalogResource } from "./provider-catalog-resource.ts"

const catalog = {
  all: [],
  connected: [],
  credentials: [],
  default: {},
} as unknown as ProviderListResponse

test("shares in-flight loads, retains loaded models and refreshes only when stale", async () => {
  let time = 0
  let calls = 0
  let release: (value: ProviderListResponse) => void = () => {}
  const resource = createProviderCatalogResource(
    () => {
      calls++
      return new Promise((resolve) => {
        release = resolve
      })
    },
    () => time
  )

  const first = resource.refreshIfStale()
  const concurrent = resource.refresh()
  assert.equal(first, concurrent)
  assert.equal(resource.getSnapshot().loading, true)
  await Promise.resolve()
  release(catalog)
  await first
  await resource.refreshIfStale()
  assert.equal(calls, 1)

  time += 5 * 60_000
  const refresh = resource.refreshIfStale()
  assert.equal(resource.getSnapshot().providers, catalog)
  assert.equal(resource.getSnapshot().loading, true)
  await Promise.resolve()
  release(catalog)
  await refresh
  assert.equal(calls, 2)
})

test("keeps the previous catalog after failure and allows an immediate retry", async () => {
  let fail = false
  const resource = createProviderCatalogResource(async () => {
    if (fail) throw new Error("offline fixture")
    return catalog
  })
  await resource.refresh()
  fail = true
  await resource.refresh()
  assert.equal(resource.getSnapshot().providers, catalog)
  assert.equal(resource.getSnapshot().failed, true)
  assert.equal(resource.getSnapshot().loading, false)
  fail = false
  await resource.refresh()
  assert.equal(resource.getSnapshot().failed, false)
})

test("an old connection's late result cannot replace the new connection's catalog", async () => {
  let release: (value: ProviderListResponse) => void = () => {}
  const old = createProviderCatalogResource(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const current = createProviderCatalogResource(async () => catalog)
  const pending = old.refresh()
  await current.refresh()
  release({ ...catalog, connected: ["old-account"] })
  await pending
  assert.equal(current.getSnapshot().providers, catalog)
  assert.deepEqual(current.getSnapshot().providers?.connected, [])
})
