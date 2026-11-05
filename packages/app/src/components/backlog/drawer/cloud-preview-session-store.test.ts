import assert from "node:assert/strict"
import test from "node:test"
import type { PreviewSessionView } from "@blame/preview-runtime"

import type { ProjectRunnerPendingOperation } from "../board/project-runner-types.ts"

import {
  acquireCloudPreviewControl,
  activeCloudPreviewControl,
  beginCloudPreviewControl,
  cachedCloudPreviewPendingOperation,
  cachedCloudPreviewSession,
  clearCloudPreviewSession,
  cloudPreviewSessionStorageId,
  publishCloudPreviewPendingOperation,
  publishCloudPreviewSession,
  subscribeCloudPreviewPendingOperation,
  subscribeCloudPreviewSession,
} from "./cloud-preview-session-store.ts"

test("serializes cloud controls across concurrently mounted runners", async () => {
  const first = beginCloudPreviewControl("story-control")
  const duplicate = beginCloudPreviewControl("story-control")

  assert.equal(first.acquired, true)
  assert.equal(duplicate.acquired, false)
  assert.equal(activeCloudPreviewControl("story-control"), first.completed)

  if (!first.acquired) throw new Error("Expected the first control lease")
  first.release()
  await duplicate.completed

  assert.equal(activeCloudPreviewControl("story-control"), undefined)
  const next = beginCloudPreviewControl("story-control")
  assert.equal(next.acquired, true)
  if (next.acquired) next.release()
})

test("waits for the active cloud control before acquiring the next lease", async () => {
  const first = beginCloudPreviewControl("story-queued-control")
  if (!first.acquired) throw new Error("Expected the first control lease")

  let acquired = false
  const queued = acquireCloudPreviewControl("story-queued-control").then(
    (lease) => {
      acquired = true
      return lease
    }
  )
  await Promise.resolve()
  assert.equal(acquired, false)

  first.release()
  const next = await queued
  assert.equal(acquired, true)
  assert.equal(
    activeCloudPreviewControl("story-queued-control"),
    next.completed
  )
  next.release()
})

test("notifies an already-mounted preview when auto-start creates its session", () => {
  const storage = new Map<string, string>()
  const storageId = cloudPreviewSessionStorageId("story", "vercel-compose")
  const received: PreviewSessionView[] = []
  const unsubscribe = subscribeCloudPreviewSession(storageId, (session) => {
    received.push(session)
  })
  const value = {
    id: "preview_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  } as PreviewSessionView

  publishCloudPreviewSession(
    { setItem: (key, item) => storage.set(key, item) },
    storageId,
    value
  )

  assert.equal(storage.get(storageId), value.id)
  assert.equal(cachedCloudPreviewSession(storageId), value)
  assert.deepEqual(received, [value])
  unsubscribe()
})

test("shares an auto-start pending operation with the mounted preview", () => {
  const storageId = cloudPreviewSessionStorageId("pending", "vercel-compose")
  const received: Array<ProjectRunnerPendingOperation | undefined> = []
  const unsubscribe = subscribeCloudPreviewPendingOperation(
    storageId,
    (operation) => received.push(operation)
  )
  const operation = { action: "start", configurationId: "web" } as const

  publishCloudPreviewPendingOperation(storageId, operation)
  assert.equal(cachedCloudPreviewPendingOperation(storageId), operation)
  publishCloudPreviewPendingOperation(storageId, undefined)

  assert.deepEqual(received, [operation, undefined])
  assert.equal(cachedCloudPreviewPendingOperation(storageId), undefined)
  unsubscribe()
})

test("clears stale persisted and in-memory session state", () => {
  const storage = new Map<string, string>()
  const storageId = cloudPreviewSessionStorageId("deleted", "vercel-compose")
  const received: Array<PreviewSessionView | undefined> = []
  const unsubscribe = subscribeCloudPreviewSession(storageId, (session) =>
    received.push(session)
  )
  const value = {
    id: "preview_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  } as PreviewSessionView
  publishCloudPreviewSession(
    { setItem: (key, item) => storage.set(key, item) },
    storageId,
    value
  )

  clearCloudPreviewSession(
    { removeItem: (key) => storage.delete(key) },
    storageId
  )

  assert.equal(cachedCloudPreviewSession(storageId), undefined)
  assert.equal(storage.has(storageId), false)
  assert.deepEqual(received, [value, undefined])
  unsubscribe()
})

test("keeps the displayed Vercel duration monotonic between usage samples", () => {
  const storage = new Map<string, string>()
  const storageId = cloudPreviewSessionStorageId("usage", "vercel-compose")
  const first = usageSession("2026-08-10T10:00:00.000Z", 0)
  const delayed = usageSession("2026-08-10T10:00:02.200Z", 0)

  publishCloudPreviewSession(
    { setItem: (key, item) => storage.set(key, item) },
    storageId,
    first
  )
  const current = publishCloudPreviewSession(
    { setItem: (key, item) => storage.set(key, item) },
    storageId,
    delayed
  )

  assert.equal(current.usage?.activeSeconds, 2)
  assert.equal(cachedCloudPreviewSession(storageId)?.usage?.activeSeconds, 2)
})

test("keeps the published session when a poll brings nothing new", () => {
  const storage = new Map<string, string>()
  const storageId = cloudPreviewSessionStorageId("same", "vercel-compose")
  const received: Array<PreviewSessionView | undefined> = []
  const unsubscribe = subscribeCloudPreviewSession(storageId, (session) =>
    received.push(session)
  )
  const writer = {
    setItem: (key: string, item: string) => storage.set(key, item),
  }
  const first = publishCloudPreviewSession(
    writer,
    storageId,
    usageSession("2026-08-10T10:00:00.000Z", 5)
  )
  const again = publishCloudPreviewSession(
    writer,
    storageId,
    usageSession("2026-08-10T10:00:00.000Z", 5)
  )

  assert.equal(again, first)
  assert.deepEqual(received, [first])
  unsubscribe()
})

function usageSession(observedAt: string, activeSeconds: number) {
  return {
    id: "preview_usageusageusageusageusageusage",
    state: { host: "running" },
    usage: { activeSeconds, estimatedCostUsd: 0, observedAt },
  } as PreviewSessionView
}
