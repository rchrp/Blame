import assert from "node:assert/strict"
import test from "node:test"
import { planChange } from "@blame/engine-client/transcript"
import type { PlanStep } from "@blame/engine-client"

import { describeToolCall, toolCallSource } from "./describe-tool-call.ts"
import { stepNumbers } from "./describe-plan.ts"

type Step = [string, PlanStep["status"], string?]
const plan = (...list: Step[]): PlanStep[] =>
  list.map(([step, status, reason]) =>
    reason ? { step, status, reason } : { step, status }
  )

/** The line an update shows as, given the plan before it. */
function line(
  before: PlanStep[] | undefined,
  after: PlanStep[],
  options: { running?: boolean; output?: string } = {}
) {
  const change = planChange(before, after)
  const view = describeToolCall(
    toolCallSource(
      {
        kind: "tool",
        title: "update_plan",
        toolName: "update_plan",
        detail: JSON.stringify({
          toolName: "update_plan",
          input: { plan: after },
          output: options.output ?? "Plan updated.",
          planChange: change,
        }),
      },
      options.running ?? false
    )
  )
  return {
    view,
    text: [view.verb, view.target?.text, ...view.chips.map((c) => c.label)]
      .filter(Boolean)
      .join(" | "),
  }
}

const start = plan(
  ["Add the endpoint", "in_progress"],
  ["Wire the form", "pending"],
  ["Write tests", "pending"]
)

test("a first plan says how many steps it has and can be opened", () => {
  const { view, text } = line(undefined, start)
  assert.equal(text, "Plan set | 3 steps")
  assert.equal(view.family, "plan")
  assert.deepEqual(view.bodies[0], {
    type: "list",
    label: "Plan",
    items: [
      "1. Add the endpoint · in progress",
      "2. Wire the form",
      "3. Write tests",
    ],
  })
})

test("a finished step reads as its number and its words, with the count", () => {
  const next = plan(
    ["Add the endpoint", "completed"],
    ["Wire the form", "in_progress"],
    ["Write tests", "pending"]
  )
  assert.equal(
    line(start, next).text,
    "Step 1 done | Add the endpoint | 1/3"
  )
})

test("several finished steps share one line", () => {
  const next = plan(
    ["Add the endpoint", "completed"],
    ["Wire the form", "completed"],
    ["Write tests", "in_progress"]
  )
  assert.equal(line(start, next).text, "Steps 1–2 done | 2/3")
  assert.equal(stepNumbers([1, 2, 4]), "Steps 1–2, 4")
  assert.equal(stepNumbers([3]), "Step 3")
})

test("a step that starts, and one that is dropped with its reason", () => {
  const moved = plan(
    ["Add the endpoint", "completed"],
    ["Wire the form", "in_progress"],
    ["Write tests", "pending"]
  )
  assert.equal(
    line(
      plan(
        ["Add the endpoint", "completed"],
        ["Wire the form", "pending"],
        ["Write tests", "pending"]
      ),
      moved
    ).text,
    "Step 2 started | Wire the form | 1/3"
  )
  const dropped = plan(
    ["Add the endpoint", "completed"],
    ["Wire the form", "in_progress"],
    ["Write tests", "abandoned", "The brief asks for no tests"]
  )
  const { view, text } = line(moved, dropped)
  assert.equal(text, "Step 3 abandoned | Write tests | 1/3")
  assert.deepEqual(view.bodies, [
    {
      type: "list",
      label: "Reason",
      items: ["Write tests: The brief asks for no tests"],
    },
  ])
})

test("a plan that closes, and one that was rewritten", () => {
  const done = plan(
    ["Add the endpoint", "completed"],
    ["Wire the form", "completed"],
    ["Write tests", "abandoned", "Not needed"]
  )
  assert.equal(
    line(
      plan(
        ["Add the endpoint", "completed"],
        ["Wire the form", "in_progress"],
        ["Write tests", "abandoned", "Not needed"]
      ),
      done
    ).text,
    "Plan complete | 2/3 | 1 abandoned"
  )
  assert.equal(
    line(start, plan(["Rework it", "in_progress"], ["Ship it", "pending"])).text,
    "Plan revised | 2 steps"
  )
})

test("an update the engine refused, and one still running", () => {
  const refused = line(undefined, start, {
    output: "Plan not updated:\n- step 1: `step` must be a non-empty string",
  })
  assert.equal(refused.view.verb, "Plan update refused")
  assert.equal(refused.view.failed, true)
  assert.equal(line(undefined, start, { running: true }).view.verb, "Updating plan")
})

test("a finish refused for open steps says so, with the steps", () => {
  const view = describeToolCall(
    toolCallSource(
      {
        kind: "tool",
        title: "finish_task",
        toolName: "finish_task",
        detail: JSON.stringify({
          toolName: "finish_task",
          input: { summary: "Done." },
          output:
            "Not accepted: `finish_task` was refused: the plan still has open steps.\n- 2. Wire the form (in progress)\n- 3. Write tests (pending)\nMark each one `completed`, or `abandoned` with a one-line reason, by calling `update_plan` with the whole plan. Then call `finish_task` again.",
        }),
      },
      false
    )
  )
  assert.equal(view.verb, "Finish refused")
  assert.equal(view.target?.text, "2 plan steps still open")
  assert.equal(view.failed, true)
  assert.deepEqual(view.bodies, [
    {
      type: "list",
      label: "Still open",
      items: ["2. Wire the form (in progress)", "3. Write tests (pending)"],
    },
  ])
})
