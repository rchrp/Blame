import test from "node:test"
import assert from "node:assert/strict"

import {
  changedFilesFromDiff,
  completedStoryReference,
  mergeDraftSummary,
} from "./user-story-context.ts"

test("a story built on a finished one names it by id and title", () => {
  assert.equal(
    completedStoryReference({ storyNumber: 42, title: " Add  OAuth login " }),
    "Builds on US-042 · Add OAuth login.\n\n"
  )
  assert.equal(
    completedStoryReference({ storyNumber: 7, title: "" }),
    "Builds on US-007.\n\n"
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
