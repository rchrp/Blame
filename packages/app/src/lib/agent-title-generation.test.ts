import assert from "node:assert/strict"
import test from "node:test"

import {
  generateAgentTitle,
  normalizedAgentTitle,
} from "./agent-title-generation.ts"

const input = {
  context: "quick-chat" as const,
  model: { providerId: "claude-code", modelId: "haiku" },
  prompt: "Read the README and the package.json of this project.",
  workspace: "/projects/v-twin",
}

// The engine's `call`, answering `generateTitle` with `answer`.
function engine(
  answer: (input: unknown) => { session: string; title: string },
  requests: unknown[] = []
) {
  return {
    call: (async (method: string, request: unknown) => {
      requests.push({ method, request })
      return answer(request)
    }) as never,
  }
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
    generateAgentTitle(
      engine(
        () => ({
          session: "s1",
          title: '<invoke name="mcp__blame__read_code">',
        }),
        requests
      ),
      input
    ),
    /did not return a title/
  )
  assert.deepEqual(requests, [
    {
      method: "generateTitle",
      request: { ...input, workspace: { root: "/projects/v-twin" } },
    },
  ])
  assert.equal(
    await generateAgentTitle(
      engine(() => ({ session: "s2", title: "Summarize project purpose" })),
      input
    ),
    "Summarize project purpose"
  )
})
