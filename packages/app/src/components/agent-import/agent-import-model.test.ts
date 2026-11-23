import assert from "node:assert/strict"
import test from "node:test"

import type { AgentImportItem, AgentImportScan } from "../../context/platform-agent-import.ts"
import {
  availableLine,
  choicesFrom,
  defaultSelection,
  groupItems,
  hasImportable,
  resultLine,
} from "./agent-import-model.ts"

const item = (
  id: string,
  state: AgentImportItem["state"],
  extra: Partial<AgentImportItem> = {}
): AgentImportItem => ({
  id,
  category: "mcp",
  name: id,
  state,
  summary: "",
  secrets: [],
  warnings: [],
  defaultSelected: state === "new",
  ...extra,
})

const scan: AgentImportScan = {
  sources: [
    {
      id: "claude-code",
      label: "Claude Code",
      location: "~/.claude",
      unsupported: [],
      items: [
        item("a", "new"),
        item("b", "conflict", { renameTo: "b-claude" }),
        item("c", "present"),
        item("d", "in-place", { category: "skill" }),
        item("e", "new", { category: "skill" }),
        item("f", "new", { defaultSelected: false }),
      ],
    },
  ],
}

test("only new and conflicting items can be decided on", () => {
  assert.equal(hasImportable(scan), true)
  assert.equal(hasImportable({ sources: [{ ...scan.sources[0]!, items: [item("c", "present"), item("d", "in-place")] }] }), false)
  assert.equal(hasImportable({ sources: [] }), false)
  assert.deepEqual(
    groupItems(scan.sources[0]!.items).map((group) => [group.category, group.items.map((i) => i.id)]),
    [["mcp", ["a", "b", "f"]], ["skill", ["e"]]]
  )
})

test("the review opens with the defaults, and a ticked conflict is imported under its new name", () => {
  assert.deepEqual([...defaultSelection(scan)].sort(), ["a", "e"])
  assert.deepEqual(choicesFrom(scan, new Set(["a", "b", "c"])), [
    { id: "a", rename: false },
    { id: "b", rename: true },
  ])
  assert.deepEqual(choicesFrom(scan, new Set()), [])
})

test("what is already there is one line, and the result is counted", () => {
  assert.equal(
    availableLine(scan.sources[0]!.items),
    "1 skill or command is already available to Blame where they are; 1 item is already in Blame"
  )
  assert.equal(
    resultLine({
      outcomes: [
        { id: "a", name: "a", status: "imported" },
        { id: "b", name: "b", status: "renamed" },
        { id: "c", name: "c", status: "skipped" },
        { id: "d", name: "d", status: "failed" },
      ],
    }),
    "2 imported, 1 left as they were, 1 failed"
  )
})
