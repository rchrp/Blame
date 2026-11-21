// What the plan shows, from the engine's plan (`Transcript.plan`): the
// pinned dock above the composer and the progress on a story's card. Pure,
// so each rule is tested without a screen.

import { openSteps } from "@blame/engine-client/transcript"
import type {
  PlanProgress,
  PlanView,
  Transcript,
} from "@blame/engine-client/transcript"
import type { StepStatus } from "@blame/engine-client"

export type PlanRow = {
  /** Position in the plan, from 1. */
  number: number
  step: string
  status: StepStatus
  /** Why the step was abandoned. */
  reason?: string
}

export type PlanDockModel = {
  /** The update that set it: a new plan is a new identity. */
  call: string
  rows: readonly PlanRow[]
  done: number
  abandoned: number
  total: number
  /** The step being worked on, else the next one to do. */
  current: PlanRow | undefined
  /** Every step is completed or abandoned. */
  finished: boolean
  /** The agent is working: the current step moves. */
  working: boolean
}

export function planRows(plan: PlanView): PlanRow[] {
  return plan.steps.map((step, index) => ({
    number: index + 1,
    step: step.step,
    status: step.status,
    ...(step.reason ? { reason: step.reason } : {}),
  }))
}

/**
 * The plan to pin, or nothing. A plan with steps still open stays, whoever
 * left them; a finished one stays until the next turn starts, as a line
 * saying the work was done.
 */
export function planDockModel(
  transcript: Pick<Transcript, "plan" | "turns" | "runningTurn"> | undefined
): PlanDockModel | undefined {
  const plan = transcript?.plan
  if (!transcript || !plan) return undefined
  const rows = planRows(plan)
  const finished = openSteps(plan.steps).length === 0
  if (finished) {
    const latest = transcript.turns.findLast(
      (turn) =>
        turn.status !== "queued" &&
        turn.status !== "rewound" &&
        turn.status !== "withdrawn"
    )
    if (latest && latest.turn !== plan.turn) return undefined
  }
  const count = (status: StepStatus) =>
    rows.filter((row) => row.status === status).length
  return {
    call: plan.call,
    rows,
    done: count("completed"),
    abandoned: count("abandoned"),
    total: rows.length,
    current:
      rows.find((row) => row.status === "in_progress") ??
      rows.find((row) => row.status === "pending"),
    finished,
    working: transcript.runningTurn !== undefined,
  }
}

/** "3/7", the count the pill shows. */
export function planCount(model: Pick<PlanProgress, "done" | "total">): string {
  return `${model.done}/${model.total}`
}

/** What a screen reader hears when the plan moves. */
export function planAnnouncement(model: PlanDockModel): string {
  if (model.finished)
    return model.abandoned
      ? `Plan complete: ${model.done} done, ${model.abandoned} abandoned.`
      : "Plan complete: all steps done."
  const progress = `${model.done} of ${model.total} steps done.`
  return model.current ? `${progress} Now: ${model.current.step}.` : progress
}

/** What the status of a row is, in words, for those who do not see its icon. */
export function statusWords(row: PlanRow): string {
  switch (row.status) {
    case "completed":
      return "Done"
    case "in_progress":
      return "In progress"
    case "abandoned":
      return row.reason ? `Abandoned: ${row.reason}` : "Abandoned"
    default:
      return "To do"
  }
}
