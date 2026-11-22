import assert from "node:assert/strict"
import test from "node:test"
import type { StoryWaitReason } from "@blame/agent-runtime/engine-protocol"

import { epicActivity, epicBoard, type EpicBoardStory } from "./epic-board.ts"

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

test("a review waits for the orchestrator, during a pause too, unless it has no conversation", () => {
  const review = [story({ id: "r", status: "in-review" })]
  assert.deepEqual(ids(board(review))["working"], ["r"])
  assert.deepEqual(
    ids(board(review, {}, { ...activeEpic, engineSessionId: null }))[
      "needs-you"
    ],
    ["r"]
  )
  const paused = board(review, {}, { ...activeEpic, status: "paused" })
  assert.deepEqual(ids(paused)["working"], ["r"])
  assert.equal(paused[1]!.entries[0]!.note, "Reviewed once the epic resumes")
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

test("a review waits for the person while the orchestrator is stopped or failed", () => {
  const review = [story({ id: "r", status: "in-review" })]
  for (const orchestrator of ["stopped", "failed"] as const) {
    const groups = epicBoard({
      epic: activeEpic,
      orchestrator,
      stories: review,
      wait: () => undefined,
      waitText: () => "",
    })
    assert.deepEqual(ids(groups)["needs-you"], ["r"])
  }
})

test("an epic's hold keeps a story queued, or needs the person when it is theirs to fix", () => {
  const stories = ["paused", "elsewhere", "budget", "direct", "branch"].map(
    (hold) => story({ id: hold, status: "ready" })
  )
  const waits = Object.fromEntries(
    stories.map((item) => [
      item.id,
      { kind: "epic", epicId: "e1", hold: item.id } as StoryWaitReason,
    ])
  )
  const groups = board(stories, waits)
  assert.deepEqual(ids(groups)["queued"], ["paused", "elsewhere"])
  assert.deepEqual(ids(groups)["needs-you"], ["budget", "direct", "branch"])
  assert.equal(groups[2]!.entries[0]!.note, "wait:epic")
})

test("a story the host calls blocked needs the person, with its reason", () => {
  const groups = epicBoard({
    epic: activeEpic,
    blocked: [{ storyId: "q", reason: "No model can run it" }],
    stories: [story({ id: "q", status: "ready" })],
    wait: () => ({ kind: "dependencies", storyIds: [], stories: [] }),
    waitText: () => "Starts after",
  })
  assert.deepEqual(ids(groups)["needs-you"], ["q"])
  assert.equal(groups[0]!.entries[0]!.note, "No model can run it")
})

test("the dot follows the orchestrator's conversation too", () => {
  const empty = board([])
  assert.equal(epicActivity({ status: "active" }, empty, "asking"), "needs-you")
  assert.equal(epicActivity({ status: "active" }, empty, "failed"), "needs-you")
  assert.equal(epicActivity({ status: "active" }, empty, "waiting"), "working")
  assert.equal(epicActivity({ status: "active" }, empty, "finished"), "done")
  assert.equal(epicActivity({ status: "paused" }, empty, "waiting"), "paused")
})

test("a problem of the epic itself needs the person", () => {
  assert.equal(
    epicActivity(
      { status: "active" },
      board([]),
      "waiting",
      "The epic's branch is gone."
    ),
    "needs-you"
  )
  assert.equal(
    epicActivity({ status: "paused" }, board([]), "waiting"),
    "paused"
  )
})
