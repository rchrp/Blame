import assert from "node:assert/strict"
import test from "node:test"

import { turnPatch } from "./agent-run-diff-range.ts"

function workspace(calls: string[]) {
  return {
    gitSnapshot: async ({ id }: { id: string }) => {
      calls.push(`snapshot:${id}`)
      return "tree-now"
    },
    gitDiffBetween: async ({ from, to }: { from: string; to: string }) => {
      calls.push(`diff:${from}:${to}`)
      return ""
    },
  }
}

test("a turn's diff runs from its snapshot to the next turn's", async () => {
  const calls: string[] = []
  await turnPatch(workspace(calls), {
    from: "tree-1",
    root: "/project",
    to: "tree-2",
  })
  assert.deepEqual(calls, ["diff:tree-1:tree-2"])
})

test("the last turn's diff runs to the files as they are now", async () => {
  const calls: string[] = []
  await turnPatch(workspace(calls), {
    from: "tree-2",
    root: "/project",
    to: undefined,
  })
  assert.deepEqual(calls, ["snapshot:engine-turn-now", "diff:tree-2:tree-now"])
})
