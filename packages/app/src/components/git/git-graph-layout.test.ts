import assert from "node:assert/strict"
import test from "node:test"

import { layoutGitGraph } from "./git-graph-layout.ts"

function commit(hash: string, parents: string[] = []) {
  return { hash, parents }
}

test("lays out an empty history without lanes", () => {
  assert.deepEqual(layoutGitGraph([]), { laneCount: 0, rows: [] })
})

test("keeps a linear history on one lane", () => {
  const graph = layoutGitGraph([
    commit("c", ["b"]),
    commit("b", ["a"]),
    commit("a", ["not-loaded"]),
  ])

  assert.equal(graph.laneCount, 1)
  assert.deepEqual(graph.rows, [
    {
      color: 0,
      column: 0,
      lines: [{ color: 0, from: 0, part: "bottom", to: 0 }],
    },
    {
      color: 0,
      column: 0,
      lines: [
        { color: 0, from: 0, part: "top", to: 0 },
        { color: 0, from: 0, part: "bottom", to: 0 },
      ],
    },
    {
      color: 0,
      column: 0,
      lines: [
        { color: 0, from: 0, part: "top", to: 0 },
        { color: 0, from: 0, part: "bottom", to: 0 },
      ],
    },
  ])
})

test("opens a lane for a merged branch and closes it at the fork point", () => {
  const graph = layoutGitGraph([
    commit("merge", ["base", "feature"]),
    commit("feature", ["base"]),
    commit("base"),
  ])

  assert.equal(graph.laneCount, 2)
  assert.deepEqual(graph.rows, [
    {
      color: 0,
      column: 0,
      lines: [
        { color: 0, from: 0, part: "bottom", to: 0 },
        { color: 1, from: 0, part: "bottom", to: 1 },
      ],
    },
    {
      color: 1,
      column: 1,
      lines: [
        { color: 0, from: 0, part: "through", to: 0 },
        { color: 1, from: 1, part: "top", to: 1 },
        { color: 1, from: 1, part: "bottom", to: 1 },
      ],
    },
    {
      color: 0,
      column: 0,
      lines: [
        { color: 0, from: 0, part: "top", to: 0 },
        { color: 1, from: 1, part: "top", to: 0 },
      ],
    },
  ])
})

test("joins a merge parent to the lane that already waits for it", () => {
  const graph = layoutGitGraph([
    commit("tip", ["base"]),
    commit("merge", ["feature", "base"]),
    commit("feature", ["base"]),
    commit("base"),
  ])

  assert.equal(graph.laneCount, 2)
  assert.deepEqual(graph.rows[1], {
    color: 1,
    column: 1,
    lines: [
      { color: 0, from: 0, part: "through", to: 0 },
      { color: 1, from: 1, part: "bottom", to: 1 },
      { color: 0, from: 1, part: "bottom", to: 0 },
    ],
  })
})

test("reuses the column of a closed branch for the next branch", () => {
  const graph = layoutGitGraph([
    commit("merge-2", ["main-2", "feature-2"]),
    commit("feature-2", ["main-2"]),
    commit("main-2", ["merge-1"]),
    commit("merge-1", ["main-1", "feature-1"]),
    commit("feature-1", ["main-1"]),
    commit("main-1"),
  ])

  assert.equal(graph.laneCount, 2)
  assert.equal(graph.rows[4].column, 1)
  assert.notEqual(graph.rows[4].color, graph.rows[1].color)
})
