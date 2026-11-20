import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { UserStoryAgentActivity } from "@/components/backlog/data/backlog-data"
import { agentRunSegments } from "./agent-run-segments.ts"

function activity(
  id: string,
  kind: UserStoryAgentActivity["kind"],
  messageKind?: UserStoryAgentActivity["messageKind"]
): UserStoryAgentActivity {
  return { createdAt: "", detail: id, id, kind, messageKind, title: id }
}

const ids = (list: UserStoryAgentActivity[]) => list.map((a) => a.id)

describe("agentRunSegments", () => {
  it("keeps a turn without steers in one segment", () => {
    const segments = agentRunSegments([
      activity("think", "reasoning"),
      activity("read", "tool"),
      activity("reply", "message", "final"),
    ])
    assert.equal(segments.length, 1)
    assert.deepEqual(ids(segments[0]!.activities), ["think", "read", "reply"])
  })

  it("opens a segment at each steer, with its acknowledgement beside it", () => {
    const segments = agentRunSegments([
      activity("run", "tool"),
      activity("steer", "user"),
      activity("think", "reasoning"),
      activity("ack", "message", "intermediate"),
      activity("read", "tool"),
      activity("note", "message", "intermediate"),
      activity("reply", "message", "final"),
    ])
    assert.deepEqual(
      segments.map((s) => s.steer?.id),
      [undefined, "steer"]
    )
    assert.deepEqual(ids(segments[0]!.activities), ["run"])
    assert.equal(segments[1]!.acknowledgement?.id, "ack")
    assert.deepEqual(ids(segments[1]!.activities), [
      "think",
      "read",
      "note",
      "reply",
    ])
  })

  it("takes no acknowledgement after a tool, nor the final reply", () => {
    const [, afterTool] = agentRunSegments([
      activity("steer", "user"),
      activity("read", "tool"),
      activity("note", "message", "intermediate"),
    ])
    assert.equal(afterTool!.acknowledgement, undefined)
    const [, finalOnly] = agentRunSegments([
      activity("steer", "user"),
      activity("reply", "message", "final"),
    ])
    assert.equal(finalOnly!.acknowledgement, undefined)
    assert.deepEqual(ids(finalOnly!.activities), ["reply"])
  })

  it("gives each of two steers its own segment", () => {
    const segments = agentRunSegments([
      activity("one", "user"),
      activity("two", "user"),
      activity("ack", "message", "intermediate"),
    ])
    assert.deepEqual(
      segments.map((s) => s.steer?.id),
      [undefined, "one", "two"]
    )
    assert.equal(segments[2]!.acknowledgement?.id, "ack")
  })
})
