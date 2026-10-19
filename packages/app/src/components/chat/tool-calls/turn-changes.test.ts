import assert from "node:assert/strict"
import test from "node:test"

import { turnChanges } from "./turn-changes.ts"

let id = 0
function tool(toolName: string, input: unknown, output?: unknown, status = "completed") {
  return {
    kind: "tool",
    status,
    title: toolName,
    toolName,
    detail: JSON.stringify({ toolName, input, output }),
    id: `a${id++}`,
  }
}

const editOutput = (path: string, additions: number, deletions: number) => ({
  status: "ok",
  data: { changes: [{ path, additions, deletions }] },
})

test("sums the files a turn edited, per file", () => {
  const changes = turnChanges([
    tool("edit_code", { operations: [] }, editOutput("src/a.ts", 3, 1)),
    tool("edit_code", { operations: [] }, editOutput("src/a.ts", 2, 0)),
    tool("apply_patch", { input: "*** Begin Patch\n*** Add File: notes.md\n+hi\n*** End Patch" }, [
      { query: "apply_patch", result: "ok", success: true },
    ]),
  ])
  assert.deepEqual(
    changes.files.map((file) => [file.path, file.additions, file.deletions, file.added]),
    [
      ["notes.md", 1, 0, true],
      ["src/a.ts", 5, 1, false],
    ]
  )
  assert.equal(changes.additions, 6)
  assert.equal(changes.deletions, 1)
})

test("ignores failed and still running edits", () => {
  const changes = turnChanges([
    tool("edit_code", { operations: [] }, { status: "blocked", category: "code", message: "Stale" }),
    tool("edit_code", { operations: [] }, undefined, "running"),
  ])
  assert.equal(changes.files.length, 0)
})

test("adds files changed by commands and keeps the latest test counts", () => {
  const changes = turnChanges([
    tool("run_task", { kind: "command", command: "prettier --write src" }, {
      status: "ok",
      data: { command: "prettier --write src", exitCode: 0, changed: true, paths: ["src/b.ts"] },
    }),
    tool("run_task", { kind: "project", task: "test" }, {
      status: "ok",
      data: { exitCode: 1, check: { counts: { executed: 3, passed: 2, failed: 1 } } },
    }),
    tool("run_task", { kind: "project", task: "test" }, {
      status: "ok",
      data: { exitCode: 0, check: { counts: { executed: 3, passed: 3, failed: 0 } } },
    }),
  ])
  assert.deepEqual(changes.files.map((file) => [file.path, file.byCommand]), [["src/b.ts", true]])
  assert.equal(changes.commands, 3)
  assert.deepEqual(changes.tests, { passed: 3, failed: 0, skipped: undefined, total: 3 })
})
