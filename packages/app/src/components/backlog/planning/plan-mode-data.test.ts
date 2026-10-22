import assert from "node:assert/strict"
import test from "node:test"

import {
  addedStoryRefs,
  latestProposalId,
  missingDependencies,
  planAttachmentContext,
  planTurnMessages,
  plannedStoryMarkdown,
  storiesToAdd,
  updatePlanStory,
  type PlanMessage,
  type PlanStory,
} from "./plan-mode-data.ts"

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

test("the agent reads the conversation without failed turns or app fields", () => {
  const messages: PlanMessage[] = [
    message("1", "user", "Plan invoices", { context: "<file>spec</file>" }),
    message("2", "assistant", "Three stories", {
      stories: [
        { ...stories[0]!, addedAs: "US-010", addedStoryId: "id-10" },
        { ...stories[1]!, dismissed: true },
      ],
    }),
    message("3", "user", "Lost", { failed: true }),
    message("4", "user", "Again"),
  ]
  const turn = planTurnMessages(messages)
  assert.equal(turn.length, 3)
  assert.equal(turn[0]!.text, "Plan invoices\n\n<file>spec</file>")
  assert.deepEqual(turn[1]!.stories![0], {
    key: "P1",
    title: "Story P1",
    summary: "Body of P1",
    priority: "Medium",
    dependsOn: [],
    addedAs: "US-010",
  })
  assert.equal(turn[1]!.stories![1]!.dismissed, true)
  assert.equal(latestProposalId(messages), "2")
  assert.deepEqual([...addedStoryRefs(messages).keys()], ["P1"])
})

test("updating one card leaves the others untouched", () => {
  const thread = {
    messages: [message("2", "assistant", "x", { stories })],
    updatedAt: "",
  }
  const next = updatePlanStory(thread, "2", "P2", { title: "Renamed" })
  assert.equal(next.messages[0]!.stories![1]!.title, "Renamed")
  assert.equal(next.messages[0]!.stories![0], stories[0])
})

function story(key: string, dependsOn: string[]): PlanStory {
  return {
    key,
    title: `Story ${key}`,
    summary: `Body of ${key}`,
    priority: "Medium",
    dependsOn,
  }
}

function message(
  id: string,
  role: PlanMessage["role"],
  text: string,
  extra: Partial<PlanMessage> = {}
): PlanMessage {
  return { id, role, text, createdAt: "2026-10-22T10:00:00Z", ...extra }
}

function keys(items: PlanStory[]) {
  return items.map((item) => item.key)
}

test("attached code and text files become context the agent can read", () => {
  const { attachments, context } = planAttachmentContext(
    [
      {
        path: "src/billing/invoice.ts",
        startLine: 3,
        endLine: 9,
        content: "export {}",
      },
    ],
    [
      { name: "spec.md", type: "text/markdown", content: btoa("# Spec") },
      { name: "shot.png", type: "image/png", content: "AAAA" },
    ]
  )
  assert.deepEqual(attachments, ["invoice.ts:3-9", "spec.md", "shot.png"])
  assert.match(
    context!,
    /<code path="src\/billing\/invoice.ts" lines="3-9">\nexport \{\}\n<\/code>/u
  )
  assert.match(context!, /<file name="spec.md">\n# Spec\n<\/file>/u)
  assert.match(
    context!,
    /<file name="shot.png" type="image\/png">Not readable as text.<\/file>/u
  )
  assert.equal(planAttachmentContext([], []).context, undefined)
})
