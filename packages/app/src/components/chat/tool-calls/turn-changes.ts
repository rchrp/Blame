import { editChanges } from "./describe-code.ts"
import {
  describeToolCall,
  toolCallSource,
  type ToolCallActivity,
} from "./describe-tool-call.ts"
import { harnessResult, list } from "./tool-call-values.ts"
import type { TestCounts } from "./tool-call-view.ts"

// What one agent turn changed, computed from its tool calls. This is the
// "this turn" diff, shown live while the agent works and at the end of the
// turn. The story's total diff comes from git instead.

const editTools = new Set([
  "edit_code",
  "apply_patch",
  "editor",
  "write_file",
  "apply_change",
  "review_change",
])

const commandTools = new Set(["run_task", "run_commands", "inspect_run", "validate_change"])

export type TurnFileChange = {
  path: string
  additions?: number
  deletions?: number
  added: boolean
  // Changed by a command (formatter, generator) rather than a direct edit:
  // the line counts are unknown.
  byCommand: boolean
}

export type TurnChanges = {
  files: TurnFileChange[]
  additions: number
  deletions: number
  commands: number
  failedCommands: number
  tests?: TestCounts
}

export type TurnActivity = ToolCallActivity & { status?: string }

export function turnChanges(activities: readonly TurnActivity[]): TurnChanges {
  const files = new Map<string, TurnFileChange>()
  let commands = 0
  let failedCommands = 0
  let tests: TestCounts | undefined

  for (const activity of activities) {
    if (activity.kind !== "tool") continue
    const source = toolCallSource(activity, activity.status === "running")
    const name = source.toolName ?? ""

    if (editTools.has(name)) {
      const change = editChanges(source)
      if (!change.applied) continue
      for (const file of change.files) {
        const current = files.get(file.path)
        files.set(file.path, {
          path: file.path,
          additions: add(current?.additions, file.additions),
          deletions: add(current?.deletions, file.deletions),
          added: current ? current.added : file.status === "added",
          byCommand: false,
        })
      }
      continue
    }

    if (commandTools.has(name)) {
      if (source.running) continue
      commands += 1
      const view = describeToolCall(source)
      if (view.failed && view.family === "command") failedCommands += 1
      const testBody = view.bodies.find((body) => body.type === "tests")
      if (testBody?.type === "tests") tests = testBody.counts
      const data = harnessResult(source.output)?.data
      if (data?.changed === true) {
        for (const path of list(data.paths)) {
          if (typeof path !== "string" || files.has(path)) continue
          files.set(path, { path, added: false, byCommand: true })
        }
      }
    }
  }

  const changed = [...files.values()].sort((left, right) => left.path.localeCompare(right.path))
  return {
    files: changed,
    additions: changed.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: changed.reduce((total, file) => total + (file.deletions ?? 0), 0),
    commands,
    failedCommands,
    tests,
  }
}

function add(left: number | undefined, right: number | undefined) {
  if (left === undefined) return right
  if (right === undefined) return left
  return left + right
}
