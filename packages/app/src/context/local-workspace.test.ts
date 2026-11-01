import assert from "node:assert/strict"
import test from "node:test"

import { workspaceBatches } from "./local-workspace.ts"

const row = (id: number) => ({ id: String(id), body: "x".repeat(80) })

test("sends a small workspace in one request", () => {
  const bundle = {
    format: "blame-workspace" as const,
    version: 1 as const,
    tables: { projects: [row(0)], user_stories: [row(1), row(2)] },
  }
  assert.deepEqual(workspaceBatches(bundle), [bundle])
})

test("splits a long history in table order and repeats the projects", () => {
  const projects = [row(0)]
  const batches = workspaceBatches(
    {
      format: "blame-workspace",
      version: 1,
      tables: {
        projects,
        user_stories: [row(1), row(2)],
        user_story_comments: [row(3)],
      },
    },
    250
  )
  assert.deepEqual(
    batches.map((batch) => batch.tables),
    [
      { projects, user_stories: [row(1)] },
      { projects, user_stories: [row(2)] },
      { projects, user_story_comments: [row(3)] },
    ]
  )
})
