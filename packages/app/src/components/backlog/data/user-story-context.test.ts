import test from "node:test"
import assert from "node:assert/strict"

import {
  changedFilesFromDiff,
  mergeDraftSummary,
  storyContextAttachment,
} from "./user-story-context.ts"

test("a story built on a finished one attaches it by id and title", () => {
  assert.deepEqual(
    storyContextAttachment({
      id: "story-42",
      storyNumber: 42,
      title: " Add  OAuth login ",
    }),
    {
      id: "story-context:story-42",
      content: "Add OAuth login",
      endLine: 1,
      origin: "story",
      path: "US-042",
      startLine: 1,
      storyId: "story-42",
    }
  )
  assert.equal(
    storyContextAttachment({ id: "story-7", storyNumber: 7, title: "" })
      .content,
    ""
  )
})

test("the same story attached twice keeps one reference", () => {
  const story = { id: "story-42", storyNumber: 42, title: "Login" }
  assert.equal(
    storyContextAttachment(story).id,
    storyContextAttachment({ ...story, title: "Renamed" }).id
  )
})

test("an unfinished draft keeps its text and gains the reference once", () => {
  const reference = "Builds on US-042 · Login.\n\n"
  assert.equal(mergeDraftSummary(undefined, reference), reference)
  assert.equal(mergeDraftSummary("", reference), reference)
  assert.equal(
    mergeDraftSummary("Add a logout button", reference),
    "Builds on US-042 · Login.\n\nAdd a logout button"
  )
  assert.equal(
    mergeDraftSummary("Builds on US-042 · Login.\n\nMore", reference),
    "Builds on US-042 · Login.\n\nMore"
  )
  assert.equal(mergeDraftSummary("Draft", undefined), "Draft")
})

test("extracts changed files from git diff", () => {
  const files = changedFilesFromDiff(
    [
      "diff --git a/src/old.ts b/src/new.ts",
      "index 123..456 100644",
      "diff --git a/package.json b/package.json",
    ].join("\n")
  )

  assert.deepEqual(files, ["src/new.ts", "package.json"])
})
