import assert from "node:assert/strict"
import test from "node:test"

import {
  fullToolDetail,
  isProposalActivity,
  proposalId,
  proposedConfiguration,
  proposedStories,
  storyProposalIds,
} from "./proposal-tools.ts"

test("only the proposal tools are cards", () => {
  assert.equal(
    isProposalActivity({ kind: "tool", toolName: "propose_user_stories" }),
    true
  )
  assert.equal(
    isProposalActivity({ kind: "tool", toolName: "propose_project_stack" }),
    true
  )
  assert.equal(
    isProposalActivity({ kind: "tool", toolName: "read_code" }),
    false
  )
  assert.equal(
    isProposalActivity({ kind: "message", toolName: "propose_user_stories" }),
    false
  )
})

test("a compacted tool call is not read as the proposal", () => {
  const summary = { excerpt: "…", originalLength: 3000, truncated: true }
  assert.equal(
    fullToolDetail(JSON.stringify({ input: { stories: [{ summary }] } })),
    undefined
  )
  assert.equal(fullToolDetail("not json"), undefined)
  const detail = fullToolDetail(
    JSON.stringify({
      input: {
        stories: [
          { key: "P1", title: " Export ", summary: "Body", priority: "High" },
          { key: "P2", title: "", summary: "dropped" },
          {
            title: "Email",
            summary: "B",
            priority: "urgent",
            dependsOn: ["P1", 3],
          },
        ],
      },
    })
  )!
  assert.deepEqual(proposedStories(detail), [
    {
      key: "P1",
      title: "Export",
      summary: "Body",
      priority: "High",
      dependsOn: [],
    },
    {
      key: "P3",
      title: "Email",
      summary: "B",
      priority: "Medium",
      dependsOn: ["P1"],
    },
  ])
})

test("the stack comes from the validated tool result, wrapped or not", () => {
  const configuration = { frontend: "next" }
  assert.deepEqual(
    proposedConfiguration({ output: { configuration } }),
    configuration
  )
  assert.deepEqual(
    proposedConfiguration({ output: { output: { configuration } } }),
    configuration
  )
})

test("story proposals are listed in conversation order, finished ones only", () => {
  const call = (id: string, status: "completed" | "failed") => ({
    createdAt: "",
    detail: "{}",
    id,
    kind: "tool" as const,
    status,
    title: "",
    toolCallId: `call-${id}`,
    toolName: "propose_user_stories",
  })
  const runs = [
    {
      createdAt: "",
      id: "r1",
      kind: "change-request" as const,
      status: "completed" as const,
      activities: [call("a", "completed")],
    },
    {
      createdAt: "",
      id: "r2",
      kind: "change-request" as const,
      status: "completed" as const,
      activities: [call("b", "failed"), call("c", "completed")],
    },
  ]
  assert.deepEqual(storyProposalIds(runs), ["r1:call-a", "r2:call-c"])
  assert.equal(proposalId(runs[0]!, runs[0]!.activities[0]!), "r1:call-a")
})
