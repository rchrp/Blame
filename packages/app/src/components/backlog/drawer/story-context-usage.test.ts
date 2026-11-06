import assert from "node:assert/strict"
import test from "node:test"

import { compactTokens, storyContextUsage } from "./story-context-usage.ts"

test("splits the last request into reused, new and free context", () => {
  const usage = storyContextUsage(
    { cacheReadTokens: 80_000, cacheWriteTokens: 4_000, inputTokens: 10_000 },
    200_000
  )
  assert.deepEqual(usage, {
    cached: 80_000,
    fresh: 14_000,
    free: 106_000,
    limit: 200_000,
    used: 94_000,
    ratio: 0.47,
  })
})

test("does not count cached tokens twice when the input already holds them", () => {
  const usage = storyContextUsage(
    { cacheReadTokens: 120_000, inputTokens: 150_000 },
    200_000
  )
  assert.equal(usage?.used, 150_000)
  assert.equal(usage?.cached, 120_000)
  assert.equal(usage?.fresh, 30_000)
})

test("does not count the cache twice when the sum still fits the window", () => {
  // The last request of a Claude Code story: the input holds the cache.
  const usage = storyContextUsage(
    { cacheReadTokens: 467_019, cacheWriteTokens: 987, inputTokens: 468_008 },
    1_000_000
  )
  assert.equal(usage?.used, 468_008)
  assert.equal(usage?.cached, 467_019)
  assert.equal(usage?.fresh, 989)
})

test("has nothing to show without usage or a known window", () => {
  assert.equal(storyContextUsage(undefined, 200_000), undefined)
  assert.equal(storyContextUsage({ inputTokens: 5 }, undefined), undefined)
  assert.equal(storyContextUsage({ inputTokens: 0 }, 200_000), undefined)
})

test("writes token counts the short way", () => {
  assert.equal(compactTokens(812), "812")
  assert.equal(compactTokens(94_200), "94k")
  assert.equal(compactTokens(1_500), "1.5k")
  assert.equal(compactTokens(1_000_000), "1M")
  assert.equal(compactTokens(1_340_000), "1.3M")
})
