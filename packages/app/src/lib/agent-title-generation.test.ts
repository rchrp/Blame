import assert from "node:assert/strict"
import test from "node:test"

import {
  generateAgentTitle,
  normalizedAgentTitle,
} from "./agent-title-generation.ts"

const input = {
  apiConnection: { url: "http://127.0.0.1:3333" },
  context: "quick-chat" as const,
  providerId: "claude-code",
  modelId: "haiku",
  prompt: "Read the README and the package.json of this project.",
  workspace: "/projects/v-twin",
}

test("keeps a short generated title without trailing punctuation", () => {
  assert.equal(
    normalizedAgentTitle("  Summarize project purpose from README.  "),
    "Summarize project purpose from README"
  )
  assert.equal(
    normalizedAgentTitle("One two three four five six seven eight"),
    "One two three four five six"
  )
})

test("rejects tool-call markup and other model scaffolding", () => {
  assert.equal(
    normalizedAgentTitle('<invoke name="mcp__blame__read_code">'),
    ""
  )
  assert.equal(normalizedAgentTitle("</parameter>"), "")
  assert.equal(normalizedAgentTitle('{"title":"Read the README"}'), "")
  assert.equal(normalizedAgentTitle("[tool call t1: read_code] {}"), "")
  assert.equal(normalizedAgentTitle("══════ Tool error ══════"), "")
})

test("rejects an empty or overly long title", () => {
  assert.equal(normalizedAgentTitle("   "), "")
  assert.equal(normalizedAgentTitle("x".repeat(81)), "")
})

test("fails instead of returning a rejected title, so callers keep their draft", async () => {
  const requests: unknown[] = []
  await assert.rejects(
    generateAgentTitle(async (request) => {
      requests.push(request)
      return { sessionId: "s1", title: '<invoke name="mcp__blame__read_code">' }
    }, input),
    /did not return a title/
  )
  assert.deepEqual(requests, [
    {
      ...input,
      cwd: "/projects/v-twin",
      workspaceRoot: "/projects/v-twin",
    },
  ])
  assert.equal(
    await generateAgentTitle(
      async () => ({ sessionId: "s2", title: "Summarize project purpose" }),
      input
    ),
    "Summarize project purpose"
  )
})
