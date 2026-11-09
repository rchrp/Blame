import assert from "node:assert/strict"
import test from "node:test"

import type { SubscriptionUsage } from "@blame/agent-runtime"

import { createPlanUsageCache, planUsageKey } from "./plan-usage-cache.ts"

function usage(planType: string): SubscriptionUsage {
  return { checkedAt: 0, planType, providerId: "claude-code", windows: [] }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, reject, resolve }
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

// Stands for the one timer of a key: `tick` is what it fires.
function fakeSchedule() {
  const timers: { stopped: boolean; tick: () => void }[] = []
  return {
    schedule: (tick: () => void) => {
      const timer = { stopped: false, tick }
      timers.push(timer)
      return () => {
        timer.stopped = true
      }
    },
    timers,
  }
}

const key = planUsageKey("https://api|user-1", "openai-codex", "work")

test("components asking at the same time share one request", async () => {
  const cache = createPlanUsageCache()
  let calls = 0
  const fetch = async () => usage(`plan ${++calls}`)
  await Promise.all([cache.load(key, fetch), cache.load(key, fetch)])
  assert.equal(calls, 1)
  const entry = cache.read(key)
  assert.ok(entry && !entry.failed)
  assert.equal(entry.usage?.planType, "plan 1")
})

test("a recent usage is reused, a stale or forced one is fetched again", async () => {
  let time = 0
  const cache = createPlanUsageCache({ now: () => time })
  let calls = 0
  const fetch = async () => usage(`plan ${++calls}`)
  await cache.load(key, fetch)
  time = 30_000
  await cache.load(key, fetch)
  assert.equal(calls, 1)
  await cache.load(key, fetch, { force: true })
  assert.equal(calls, 2)
  time = 100_000
  await cache.load(key, fetch)
  assert.equal(calls, 3)
})

test("the previous usage stays shown while a new one is fetched", async () => {
  let time = 0
  const cache = createPlanUsageCache({ now: () => time })
  await cache.load(key, async () => usage("old"))
  time = 100_000
  const next = deferred<SubscriptionUsage>()
  const loading = cache.load(key, () => next.promise)
  await flush()
  const during = cache.read(key)
  assert.ok(during && !during.failed)
  assert.equal(during.usage?.planType, "old")
  next.resolve(usage("new"))
  await loading
  const after = cache.read(key)
  assert.ok(after && !after.failed)
  assert.equal(after.usage?.planType, "new")
})

test("a usage that is not available is kept as such", async () => {
  const cache = createPlanUsageCache()
  let calls = 0
  const fetch = async () => (++calls, null)
  await cache.load(key, fetch)
  await cache.load(key, fetch)
  assert.equal(calls, 1)
  const entry = cache.read(key)
  assert.ok(entry && !entry.failed)
  assert.equal(entry.usage, null)
})

test("a failed fetch is not kept: the next ask fetches again", async () => {
  const cache = createPlanUsageCache()
  let calls = 0
  const fetch = async () => {
    if (++calls === 1) throw new Error("offline")
    return usage("recovered")
  }
  await cache.load(key, fetch)
  assert.deepEqual(cache.read(key), { failed: true })
  await cache.load(key, fetch)
  assert.equal(calls, 2)
  const entry = cache.read(key)
  assert.ok(entry && !entry.failed)
  assert.equal(entry.usage?.planType, "recovered")
})

test("a fetch that throws at once counts as failed", async () => {
  const cache = createPlanUsageCache()
  await cache.load(key, () => {
    throw new Error("no agent")
  })
  assert.deepEqual(cache.read(key), { failed: true })
})

test("listeners hear each answer once", async () => {
  const cache = createPlanUsageCache()
  let heard = 0
  const stop = cache.subscribe(() => heard++)
  await Promise.all([
    cache.load(key, async () => usage("plan")),
    cache.load(key, async () => usage("plan")),
  ])
  assert.equal(heard, 1)
  stop()
  await cache.load(key, async () => usage("plan"), { force: true })
  assert.equal(heard, 1)
})

test("watchers of one key share a single timer", async () => {
  const timer = fakeSchedule()
  const cache = createPlanUsageCache({ schedule: timer.schedule })
  let calls = 0
  const fetch = async () => usage(`plan ${++calls}`)
  const stopDrawer = cache.watch(key, fetch)
  const stopSettings = cache.watch(key, fetch)
  await flush()
  assert.equal(timer.timers.length, 1)
  assert.equal(calls, 1)
  stopDrawer()
  assert.equal(timer.timers[0].stopped, false)
  stopSettings()
  assert.equal(timer.timers[0].stopped, true)
})

test("a tick fetches only a stale usage", async () => {
  let time = 0
  const timer = fakeSchedule()
  const cache = createPlanUsageCache({
    now: () => time,
    schedule: timer.schedule,
  })
  let calls = 0
  const fetch = async () => usage(`plan ${++calls}`)
  cache.watch(key, fetch)
  await flush()
  time = 10_000
  timer.timers[0].tick()
  await flush()
  assert.equal(calls, 1)
  time = 60_000
  timer.timers[0].tick()
  await flush()
  assert.equal(calls, 2)
})

test("watching again right away reuses the usage", async () => {
  const timer = fakeSchedule()
  const cache = createPlanUsageCache({ schedule: timer.schedule })
  let calls = 0
  const fetch = async () => usage(`plan ${++calls}`)
  cache.watch(key, fetch)()
  await flush()
  cache.watch(key, fetch)
  await flush()
  assert.equal(calls, 1)
  assert.equal(timer.timers.length, 2)
  assert.equal(timer.timers[0].stopped, true)
})

test("clearing drops the usage and an answer still on its way", async () => {
  const cache = createPlanUsageCache()
  await cache.load(key, async () => usage("connected"))
  const late = deferred<SubscriptionUsage>()
  const loading = cache.load(key, () => late.promise, { force: true })
  await flush()
  let heard = 0
  cache.subscribe(() => heard++)
  cache.clear()
  assert.equal(cache.read(key), undefined)
  assert.equal(heard, 1)
  late.resolve(usage("previous account"))
  await loading
  assert.equal(cache.read(key), undefined)
  assert.equal(heard, 1)
})

test("reloading drops the usage and fetches what is still shown", async () => {
  const timer = fakeSchedule()
  const cache = createPlanUsageCache({ schedule: timer.schedule })
  const other = planUsageKey("https://api|user-1", "openai-codex", "home")
  let calls = 0
  const fetch = async () => usage(`plan ${++calls}`)
  await cache.load(other, fetch)
  cache.watch(key, fetch)
  await flush()
  assert.equal(calls, 2)
  cache.reload()
  assert.equal(cache.read(key), undefined)
  assert.equal(cache.read(other), undefined)
  await flush()
  assert.equal(calls, 3)
  const entry = cache.read(key)
  assert.ok(entry && !entry.failed)
  assert.equal(entry.usage?.planType, "plan 3")
  assert.equal(cache.read(other), undefined)
})

test("Claude Code has one entry per account, ChatGPT one per credential", () => {
  const account = "https://api|user-1"
  assert.equal(
    planUsageKey(account, "claude-code", "work"),
    planUsageKey(account, "claude-code", "home")
  )
  assert.equal(
    planUsageKey(account, "claude-code", undefined),
    planUsageKey(account, "claude-code", "home")
  )
  assert.notEqual(
    planUsageKey(account, "openai-codex", "work"),
    planUsageKey(account, "openai-codex", "home")
  )
  assert.notEqual(
    planUsageKey(account, "claude-code", undefined),
    planUsageKey("https://api|user-2", "claude-code", undefined)
  )
  assert.notEqual(
    planUsageKey(account, "claude-code", undefined),
    planUsageKey(account, "openai-codex", undefined)
  )
})
