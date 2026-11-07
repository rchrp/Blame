import assert from "node:assert/strict"
import test from "node:test"

import { storiesInTransition, storyTransitionKind, withStoryTransition } from "./story-transitions.ts"

test("runs one action per story at a time", async () => {
  let release: () => void = () => undefined
  const first = withStoryTransition("s1", () => new Promise<string>((resolve) => { release = () => resolve("first") }))
  assert.equal(storiesInTransition().has("s1"), true)
  assert.equal(await withStoryTransition("s1", async () => "second"), undefined)
  assert.equal(await withStoryTransition("s2", async () => "other story"), "other story")
  release()
  assert.equal(await first, "first")
  assert.equal(storiesInTransition().has("s1"), false)
})

test("names a merge while it runs", async () => {
  let release: () => void = () => undefined
  const merge = withStoryTransition("s4", () => new Promise<void>((resolve) => { release = resolve }), "merge")
  assert.equal(storyTransitionKind("s4"), "merge")
  assert.equal(await withStoryTransition("s4", async () => "second merge", "merge"), undefined)
  release()
  await merge
  assert.equal(storyTransitionKind("s4"), undefined)
})

test("frees the story when the action fails", async () => {
  await assert.rejects(withStoryTransition("s3", async () => { throw new Error("boom") }))
  assert.equal(storiesInTransition().has("s3"), false)
})
