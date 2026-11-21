import assert from "node:assert/strict"
import test from "node:test"
import type { PlanStep } from "@blame/engine-client"
import type { Transcript, TurnView } from "@blame/engine-client/transcript"

import {
  planAnnouncement,
  planCount,
  planDockModel,
  planProgress,
  statusWords,
} from "./plan-model.ts"

const steps: PlanStep[] = [
  { step: "Add the endpoint", status: "completed" },
  { step: "Wire the form", status: "in_progress" },
  { step: "Write tests", status: "pending" },
  { step: "Support SSO", status: "abandoned", reason: "Out of scope" },
]

const turn = (id: string, status: TurnView["status"] = "completed") =>
  ({ turn: id, status }) as TurnView

function transcript(
  plan: PlanStep[] | undefined,
  options: { turns?: TurnView[]; running?: boolean; turnOfPlan?: string } = {}
): Pick<Transcript, "plan" | "turns" | "runningTurn"> {
  return {
    plan: plan && {
      steps: plan,
      turn: options.turnOfPlan ?? "t1",
      call: "call-1",
      seq: 5,
    },
    turns: options.turns ?? [turn("t1", "running")],
    runningTurn: options.running ? "t1" : undefined,
  }
}

test("the dock shows where the plan stands and which step is current", () => {
  const model = planDockModel(transcript(steps, { running: true }))!
  assert.equal(model.total, 4)
  assert.equal(model.done, 1)
  assert.equal(model.abandoned, 1)
  assert.equal(model.current?.step, "Wire the form")
  assert.equal(model.current?.number, 2)
  assert.equal(model.finished, false)
  assert.equal(model.working, true)
  assert.equal(planCount(model), "1/4")
})

test("with nothing in progress, the next step to do is the current one", () => {
  const model = planDockModel(
    transcript([
      { step: "Add it", status: "completed" },
      { step: "Test it", status: "pending" },
    ])
  )!
  assert.equal(model.current?.step, "Test it")
  assert.equal(model.working, false)
})

test("there is no dock without a plan", () => {
  assert.equal(planDockModel(transcript(undefined)), undefined)
  assert.equal(planDockModel(undefined), undefined)
})

test("a finished plan stays until the next turn starts, an open one stays whoever left it", () => {
  const done: PlanStep[] = [
    { step: "Add it", status: "completed" },
    { step: "Drop it", status: "abandoned", reason: "Not needed" },
  ]
  const same = planDockModel(transcript(done, { turns: [turn("t1")] }))!
  assert.equal(same.finished, true)
  assert.equal(same.current, undefined)
  // A turn that did not touch it came after: the work moved on.
  assert.equal(
    planDockModel(transcript(done, { turns: [turn("t1"), turn("t2", "running")] })),
    undefined
  )
  // Its own turn still counts when a message waits behind it.
  assert.ok(
    planDockModel(
      transcript(done, { turns: [turn("t1"), turn("t2", "queued")] })
    )
  )
  // Steps left open by an earlier turn are still the agent's to settle.
  assert.ok(
    planDockModel(
      transcript(steps, { turns: [turn("t1", "interrupted"), turn("t2", "running")] })
    )
  )
})

test("a screen reader is told how far the plan is, and what is next", () => {
  const model = planDockModel(transcript(steps))!
  assert.equal(planAnnouncement(model), "1 of 4 steps done. Now: Wire the form.")
  assert.equal(
    planAnnouncement(
      planDockModel(
        transcript([{ step: "Add it", status: "completed" }], {
          turns: [turn("t1")],
        })
      )!
    ),
    "Plan complete: all steps done."
  )
  assert.equal(statusWords(model.rows[3]!), "Abandoned: Out of scope")
  assert.equal(statusWords(model.rows[2]!), "To do")
})

test("a card needs only the count and the current step", () => {
  assert.deepEqual(
    planProgress({ steps, turn: "t1", call: "c", seq: 1 }),
    { done: 1, abandoned: 1, total: 4, current: "Wire the form" }
  )
  assert.equal(planProgress(undefined), undefined)
})
