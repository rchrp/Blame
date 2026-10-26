import test from "node:test"
import assert from "node:assert/strict"
import {
  collectResearchSources,
  citationIds,
  researchOutput,
} from "./web-research-data.ts"
import { describeWebResearch } from "../tool-calls/describe-web-research.ts"

const source = {
  id: "web_1234567890abcdef12345678",
  url: "https://example.org/article",
  title: "Article",
  domain: "example.org",
  snippet: "Search excerpt",
  retrievedAt: "2026-10-26T12:00:00Z",
}
const search = {
  kind: "web_search",
  query: "readability extraction",
  sources: [source],
  resultCount: 1,
  partial: false,
}
const entry = (result: unknown, runId = "one") => ({
  runId,
  kind: "tool",
  detail: JSON.stringify({ output: result }),
})

test("found, consulted and cited are independent facts, including a citation to a snippet", () => {
  const found = collectResearchSources(
    [entry(search)],
    [`Claim [Example](#source-${source.id})`]
  )[0]!
  assert.equal(found.found, true)
  assert.equal(found.consulted, false)
  assert.equal(found.cited, true)
  const failed = collectResearchSources(
    [
      entry(search),
      entry({
        kind: "web_page",
        source,
        status: "failed",
        content: "",
        error: "HTTP 403",
      }),
    ],
    []
  )[0]!
  assert.equal(failed.consulted, false)
  assert.equal(failed.error, "HTTP 403")
})

test("merges repeated sources across turns without losing read evidence or metadata", () => {
  const read = {
    kind: "web_page",
    source: { ...source, title: "Full article", author: "Jane" },
    status: "read",
    content: "Actual article text",
    method: "readability",
  }
  const sources = collectResearchSources(
    [entry(search), entry(read), entry(search, "two")],
    []
  )
  assert.equal(sources.length, 1)
  assert.deepEqual(sources[0]?.runIds, ["one", "two"])
  assert.equal(sources[0]?.title, "Full article")
  assert.equal(sources[0]?.author, "Jane")
  assert.equal(sources[0]?.consulted, true)
})

test("resolves SDK envelopes and does not count links in code or fabricated source ids", () => {
  assert.equal(
    researchOutput({
      content: [{ type: "text", text: JSON.stringify(search) }],
    })?.query,
    search.query
  )
  assert.equal(citationIds(`\`[example](#source-${source.id})\``).size, 0)
  assert.equal(
    citationIds(`\`\`\`md\n[example](#source-${source.id})\n\`\`\``).size,
    0
  )
  const sources = collectResearchSources(
    [entry(search)],
    ["[missing](#source-web_aaaaaaaaaaaaaaaaaaaaaaaa)"]
  )
  assert.equal(sources[0]?.cited, false)
  assert.equal(
    collectResearchSources(
      [
        entry({
          ...search,
          sources: [{ ...source, url: "javascript:alert(1)" }],
        }),
      ],
      []
    ).length,
    0
  )
})

test("search rows show the query, returned count, favicons and partial availability", () => {
  const view = describeWebResearch({
    toolName: "search_web",
    input: { query: search.query },
    output: { ...search, partial: true, unavailableEngines: ["google"] },
    running: false,
    kind: "tool",
    title: "",
    detail: "",
  })
  assert.equal(view.target?.text, search.query)
  assert.equal(view.chips[0]?.label, "1 result")
  assert.equal(view.webSources?.[0]?.domain, "example.org")
  assert.equal(view.chips[1]?.label, "Partial results")
})

test("failed page rows never claim successful reading", () => {
  const view = describeWebResearch({
    toolName: "read_web_page",
    input: { url: source.url },
    output: {
      kind: "web_page",
      source,
      status: "failed",
      content: "",
      error: "HTTP 403",
    },
    running: false,
    kind: "tool",
    title: "",
    detail: "",
  })
  assert.equal(view.failed, true)
  assert.equal(view.verb, "Could not read")
  assert.equal(
    view.bodies.find((body) => body.type === "web-sources")?.reading,
    false
  )
})
