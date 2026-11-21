import assert from "node:assert/strict"
import test from "node:test"
import type { StoryWaitReason } from "@blame/agent-runtime/engine-protocol"

import {
  epicActivity,
  epicBoard,
  workingStoryIds,
  type EpicBoardStory,
} from "./epic-board.ts"

let nextNumber = 1

function story(overrides: Partial<EpicBoardStory>): EpicBoardStory {
  const storyNumber = overrides.storyNumber ?? nextNumber++
  return {
    createdAt: "2026-11-21T10:00:00.000Z",
    epicId: "e1",
    id: `s${storyNumber}`,
    status: "ready",
    storyNumber,
    title: `Story ${storyNumber}`,
    ...overrides,
  }
}

const activeEpic = {
  id: "e1",
  status: "active",
  engineSessionId: "sess",
} as const

function board(
  stories: EpicBoardStory[],
  waits: Record<string, StoryWaitReason> = {},
  epic: Parameters<typeof epicBoard>[0]["epic"] = activeEpic
) {
  return epicBoard({
    epic,
    stories,
    wait: (id) => waits[id],
    waitText: (reason) => `wait:${reason.kind}`,
  })
}

function ids(groups: ReturnType<typeof board>) {
  return Object.fromEntries(
    groups.map((group) => [
      group.id,
      group.entries.map((entry) => entry.story.id),
    ])
  )
}

test("each status lands in its group, other epics' stories stay out", () => {
  const groups = board([
    story({ id: "done", status: "done" }),
    story({ id: "gone", status: "discarded" }),
    story({ id: "run", status: "in-progress", agentStatus: "Running" }),
    story({ id: "next", status: "ready" }),
    story({ id: "held", status: "backlog" }),
    story({ id: "other", epicId: "e2", status: "in-progress" }),
    story({ id: "loose", epicId: null, status: "ready" }),
  ])
  assert.deepEqual(ids(groups), {
    "needs-you": [],
    working: ["run"],
    queued: ["next", "held"],
    merged: ["done"],
    rejected: ["gone"],
  })
  assert.deepEqual(
    groups.map((group) => group.title),
    ["Needs you", "Working", "Queued", "In the epic branch", "Rejected"]
  )
})

test("a wait only the person can end needs them; the others stay queued", () => {
  const groups = board(
    [
      story({ id: "after" }),
      story({ id: "model" }),
      story({ id: "failed", agentLastError: "No worktree" }),
    ],
    {
      after: { kind: "dependencies", storyIds: ["x"], stories: [] },
      model: { kind: "no-model" },
    }
  )
  assert.deepEqual(ids(groups)["queued"], ["after"])
  assert.deepEqual(ids(groups)["needs-you"], ["model", "failed"])
  const needs = groups[0]!.entries
  assert.equal(needs[0]!.note, "wait:no-model")
  assert.equal(needs[1]!.note, "No worktree")
  assert.ok(needs.every((entry) => entry.alert))
  assert.equal(groups[2]!.entries[0]!.note, "wait:dependencies")
})

test("a review is the orchestrator's only while the epic runs with a conversation", () => {
  const review = [story({ id: "r", status: "in-review" })]
  assert.deepEqual(ids(board(review))["working"], ["r"])
  assert.deepEqual(
    ids(board(review, {}, { ...activeEpic, engineSessionId: null }))[
      "needs-you"
    ],
    ["r"]
  )
  assert.deepEqual(
    ids(board(review, {}, { ...activeEpic, status: "paused" }))["needs-you"],
    ["r"]
  )
})

test("a paused agent needs the person unless the whole epic is paused", () => {
  const paused = [
    story({ id: "p", status: "in-progress", agentStatus: "Paused" }),
  ]
  assert.deepEqual(ids(board(paused))["needs-you"], ["p"])
  assert.deepEqual(
    ids(board(paused, {}, { ...activeEpic, status: "paused" }))["working"],
    ["p"]
  )
})

test("stories are ordered by number", () => {
  const groups = board([
    story({ id: "b", storyNumber: 20, status: "done" }),
    story({ id: "a", storyNumber: 3, status: "done" }),
  ])
  assert.deepEqual(ids(groups)["merged"], ["a", "b"])
})

test("the sidebar dot follows what the epic owes", () => {
  const working = board([
    story({ status: "in-progress", agentStatus: "Running" }),
  ])
  assert.equal(epicActivity({ status: "active" }, working), "working")
  assert.equal(epicActivity({ status: "paused" }, working), "paused")
  const needs = board(
    [story({ status: "in-review" })],
    {},
    { ...activeEpic, engineSessionId: null }
  )
  assert.equal(epicActivity({ status: "active" }, needs), "needs-you")
  assert.equal(epicActivity({ status: "paused" }, needs), "needs-you")
  const merged = board([
    story({ status: "done" }),
    story({ status: "discarded" }),
  ])
  assert.equal(epicActivity({ status: "active" }, merged), "done")
  assert.equal(epicActivity({ status: "completed" }, board([])), "done")
  assert.equal(epicActivity({ status: "active" }, board([])), undefined)
  assert.equal(epicActivity({ status: "discarded" }, working), undefined)
})

test("Pause all stops the epic's running agents only", () => {
  const stories = [
    story({ id: "run", status: "in-progress", agentStatus: "Running" }),
    story({ id: "stopped", status: "in-progress", agentStatus: "Paused" }),
    story({
      id: "other",
      epicId: "e2",
      status: "in-progress",
      agentStatus: "Running",
    }),
    story({ id: "review", status: "in-review" }),
  ]
  assert.deepEqual(workingStoryIds({ id: "e1" }, stories), ["run"])
})
