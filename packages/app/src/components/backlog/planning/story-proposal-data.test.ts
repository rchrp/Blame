import assert from "node:assert/strict"
import test from "node:test"

import {
  addedStoryRefs,
  decidedStories,
  missingDependencies,
  plannedStoryDraft,
  plannedStoryMarkdown,
  proposalDecisionsNote,
  storiesToAdd,
  storyFileAttachments,
  type PlanStory,
} from "./story-proposal-data.ts"

const stories: PlanStory[] = [
  story("P1", []),
  story("P2", ["P1"]),
  story("P3", ["P2", "US-004"]),
  story("P4", []),
]

test("adds dependencies first, once, and skips stories already added", () => {
  assert.deepEqual(keys(storiesToAdd(stories, ["P3"])), ["P1", "P2", "P3"])
  assert.deepEqual(keys(storiesToAdd(stories, ["P4", "P3", "P2"])), [
    "P4",
    "P1",
    "P2",
    "P3",
  ])
  const withAdded = stories.map((item) =>
    item.key === "P1" ? { ...item, addedAs: "US-010" } : item
  )
  assert.deepEqual(keys(storiesToAdd(withAdded, ["P3"])), ["P2", "P3"])
  assert.deepEqual(missingDependencies(withAdded, "P3"), ["P2"])
  assert.deepEqual(missingDependencies(stories, "P4"), [])
})

test("a dependency cycle from the agent does not loop", () => {
  const cycle = [story("P1", ["P2"]), story("P2", ["P1"])]
  assert.deepEqual(keys(storiesToAdd(cycle, ["P1"])), ["P2", "P1"])
})

test("the story description names its dependencies by backlog id", () => {
  const markdown = plannedStoryMarkdown(stories[2]!, (key) =>
    key === "P2" ? { displayId: "US-011", title: "Story P2" } : undefined
  )
  assert.equal(
    markdown,
    "Body of P3\n\n## Depends on\n- US-011 · Story P2 (to be merged first)\n- US-004 (to be merged first)"
  )
  assert.equal(
    plannedStoryMarkdown(stories[0]!, () => undefined),
    "Body of P1"
  )
})

test("the person's edits and decisions apply over the agent's proposal", () => {
  const decided = decidedStories(stories, {
    P2: { title: "Renamed", addedAs: "US-011", addedStoryId: "s11" },
    P4: { dismissed: true },
  })
  assert.equal(decided[1]!.title, "Renamed")
  assert.equal(decided[0]!.title, "Story P1")
  assert.deepEqual([...addedStoryRefs([decided]).keys()], ["P2"])
  assert.equal(
    proposalDecisionsNote(decided),
    "<proposal_decisions>\nWhat I did with your latest proposed stories:\n- P2 added to the backlog as US-011\n- P4 dismissed\n</proposal_decisions>"
  )
  assert.equal(proposalDecisionsNote(stories), undefined)
})

test("each story drafts with only the files it names", () => {
  const mockup = attachment("f1", "mockup.png")
  const spec = attachment("f2", "spec.pdf")
  const available = [mockup, spec]
  const screen = { ...story("P1", []), attachments: ["mockup.png"] }
  const docs = { ...story("P2", []), attachments: ["spec.pdf"] }

  assert.deepEqual(
    plannedStoryDraft(screen, () => undefined, available),
    {
      title: "Story P1",
      summary: "Body of P1",
      priority: "Medium",
      status: "backlog",
      fileAttachments: [mockup],
    }
  )
  assert.deepEqual(
    plannedStoryDraft(docs, () => undefined, available).fileAttachments,
    [spec]
  )
})

test("a story that names no available file drafts without attachments", () => {
  const unmatched = { ...story("P1", []), attachments: ["gone.png"] }
  const available = [attachment("f1", "mockup.png")]

  assert.equal(
    "fileAttachments" in
      plannedStoryDraft(stories[0]!, () => undefined, available),
    false
  )
  assert.equal(
    "fileAttachments" in
      plannedStoryDraft(unmatched, () => undefined, available),
    false
  )
})

test("a name attached twice resolves to the latest file, once", () => {
  const first = attachment("f1", "image.png")
  const second = attachment("f2", "image.png")
  const spec = attachment("f3", "spec.pdf")
  const proposal = {
    attachments: ["image.png", "spec.pdf", "image.png"],
  }

  assert.deepEqual(storyFileAttachments(proposal, [first, spec, second]), [
    second,
    spec,
  ])
  assert.deepEqual(storyFileAttachments(proposal, []), [])
})

function story(key: string, dependsOn: string[]): PlanStory {
  return {
    key,
    title: `Story ${key}`,
    summary: `Body of ${key}`,
    priority: "Medium",
    dependsOn,
    attachments: [],
  }
}

function attachment(id: string, name: string) {
  return { id, name, size: 10, type: "image/png" }
}

function keys(items: PlanStory[]) {
  return items.map((item) => item.key)
}
