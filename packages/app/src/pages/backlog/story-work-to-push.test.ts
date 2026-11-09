import assert from "node:assert/strict"
import test from "node:test"

import { storyWorkToPush } from "./story-work-to-push.ts"

const story = {
  branch: "blame/story-US-001",
  pullRequestUrl: "https://github.com/acme/app/pull/12",
  worktree: "/story-worktree",
}

function workspace({
  diff = "",
  refs = [{ name: "origin/blame/story-US-001", type: "remote" }],
}: {
  diff?: string
  refs?: Array<{ name: string; type: string }>
} = {}) {
  const calls: string[] = []
  return {
    calls,
    async gitLog(input: {
      root: string
      limit: number
      currentBranchOnly?: boolean
    }) {
      calls.push("gitLog")
      assert.deepEqual(input, {
        root: "/story-worktree",
        limit: 1,
        currentBranchOnly: true,
      })
      return [{ hash: "head", refs }]
    },
    async gitDiff(input: { root: string }) {
      calls.push("gitDiff")
      assert.deepEqual(input, { root: "/story-worktree" })
      return diff
    },
  }
}

test("a pushed branch with a clean worktree has nothing to push", async () => {
  assert.equal(await storyWorkToPush(story, workspace()), false)
})

test("commits missing from the remote branch are work to push", async () => {
  const unpushed = workspace({
    refs: [{ name: "blame/story-US-001", type: "head" }],
  })

  assert.equal(await storyWorkToPush(story, unpushed), true)
  assert.deepEqual(unpushed.calls, ["gitLog"])
})

test("another remote branch on HEAD does not count as the story branch", async () => {
  const other = workspace({ refs: [{ name: "origin/main", type: "remote" }] })

  assert.equal(await storyWorkToPush(story, other), true)
})

test("uncommitted changes on a pushed branch are work to push", async () => {
  const dirty = workspace({ diff: "diff --git a/source.ts b/source.ts\n" })

  assert.equal(await storyWorkToPush(story, dirty), true)
  assert.deepEqual(dirty.calls, ["gitLog", "gitDiff"])
})

test("a story without a pull request or a branch never asks git", async () => {
  for (const incomplete of [
    { ...story, pullRequestUrl: null },
    { ...story, branch: undefined },
    { ...story, worktree: null },
  ]) {
    const idle = workspace()
    assert.equal(await storyWorkToPush(incomplete, idle), false)
    assert.deepEqual(idle.calls, [])
  }
})

test("an empty history or a git failure offers nothing to push", async () => {
  assert.equal(
    await storyWorkToPush(story, {
      async gitLog() {
        return []
      },
      async gitDiff() {
        assert.fail("No HEAD to compare with")
      },
    }),
    false
  )
  assert.equal(
    await storyWorkToPush(story, {
      async gitLog() {
        throw new Error("Worktree unavailable")
      },
      async gitDiff() {
        assert.fail("No HEAD to compare with")
      },
    }),
    false
  )
})
