import assert from "node:assert/strict"
import test from "node:test"

import {
  matchingSkills,
  skillInvocation,
  skillMentionState,
} from "./skill-mention.ts"

test("the picker opens for a slash at the start of the message only", () => {
  assert.deepEqual(skillMentionState("/", 1), {
    active: true,
    query: "",
    start: 0,
    end: 1,
  })
  assert.equal(skillMentionState("/dep", 4).query, "dep")
  assert.equal(skillMentionState("/frontend:co", 12).query, "frontend:co")
  assert.equal(skillMentionState("/deploy staging", 15).active, false)
  assert.equal(skillMentionState("fix /dep", 8).active, false)
  assert.equal(skillMentionState("/usr/bin", 8).active, false)
  assert.equal(skillMentionState(" /dep", 5).active, false)
  assert.equal(skillMentionState("", 0).active, false)
  // The cursor decides: the text after it is not the query.
  assert.equal(skillMentionState("/deploy", 4).query, "dep")
})

test("skills are matched by name first, then description", () => {
  const items = [
    { name: "pdf", description: "Work with PDF files" },
    { name: "review-pr", description: "Review a pull request" },
    { name: "deploy", description: "Deploy; also reviews the pdf output" },
    { name: "frontend:component" },
  ]
  assert.deepEqual(
    matchingSkills(items, "").map((item) => item.name),
    ["pdf", "review-pr", "deploy", "frontend:component"]
  )
  assert.deepEqual(
    matchingSkills(items, "pd").map((item) => item.name),
    ["pdf", "deploy"]
  )
  assert.deepEqual(
    matchingSkills(items, "PDF").map((item) => item.name),
    ["pdf", "deploy"]
  )
  assert.deepEqual(
    matchingSkills(items, "comp").map((item) => item.name),
    ["frontend:component"]
  )
  assert.deepEqual(
    matchingSkills(items, "pr").map((item) => item.name),
    ["review-pr"]
  )
  assert.deepEqual(matchingSkills(items, "nothing"), [])
  assert.equal(matchingSkills(items, "", 2).length, 2)
})

test("picking a skill writes its name and room for arguments", () => {
  assert.equal(skillInvocation({ name: "deploy" }), "/deploy ")
})
