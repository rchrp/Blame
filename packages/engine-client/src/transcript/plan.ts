// The agent's plan, as a client reads it from the log. A mirror of
// `View::plan` in crates/blame-engine-core/src/plan.rs: the plan is the input
// of the latest `update_plan` call that completed, among the records in
// effect, so a rewind, a fork and a reconnect give it back as the log says.

import type {
  JsonValue,
  PlanStep,
  Seq,
  StepStatus,
  ToolCallId,
  TurnId,
} from "../protocol.js";

/** The tool the model calls to set its plan, and what it answers to. */
export const PLAN_TOOL = "update_plan";

/** The plan in effect and where it was set. */
export interface PlanView {
  readonly steps: readonly PlanStep[];
  /** The turn whose call set it. */
  readonly turn: TurnId;
  readonly call: ToolCallId;
  /** The record that answered the call: the plan took effect there. */
  readonly seq: Seq;
}

/**
 * What one update did to the plan before it, for the one line the transcript
 * shows in place of a tool call.
 */
export type PlanChange =
  /** The first plan. */
  | { readonly kind: "created"; readonly total: number }
  /** The same steps, further along. Positions are 1-based. */
  | {
      readonly kind: "progress";
      readonly completed: readonly number[];
      readonly abandoned: readonly number[];
      /** The step now in progress, when that is what changed. */
      readonly started: number | undefined;
      readonly done: number;
      readonly total: number;
    }
  /** Every step is completed or abandoned. */
  | {
      readonly kind: "finished";
      readonly completed: readonly number[];
      readonly done: number;
      readonly abandoned: number;
      readonly total: number;
    }
  /** Steps were added, removed, reworded, reordered or reopened. */
  | { readonly kind: "revised"; readonly total: number }
  /** Nothing the person can see changed. */
  | { readonly kind: "same" };

const STATUSES: readonly StepStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "abandoned",
];

/**
 * The steps of an `update_plan` input, as the engine read them (trimmed, a
 * reason only on abandoned steps); `undefined` when the input is not a plan.
 * The engine refused such an input, so a completed call always parses.
 */
export function parsePlan(input: JsonValue): PlanStep[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const list = input.plan;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const steps: PlanStep[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return undefined;
    const step = oneLine(item.step);
    const status = STATUSES.find((known) => known === item.status);
    if (!step || !status) return undefined;
    const reason = oneLine(item.reason);
    steps.push(
      status === "abandoned" && reason
        ? { step, status, reason }
        : { step, status },
    );
  }
  return steps;
}

function oneLine(value: JsonValue | undefined): string {
  return typeof value === "string"
    ? value.split(/\s+/u).filter(Boolean).join(" ")
    : "";
}

/** The steps that still have to be done or dropped. */
export function openSteps(plan: readonly PlanStep[]): PlanStep[] {
  return plan.filter(
    (step) => step.status === "pending" || step.status === "in_progress",
  );
}

/** What `next` did to `previous`, which is `undefined` for the first plan. */
export function planChange(
  previous: readonly PlanStep[] | undefined,
  next: readonly PlanStep[],
): PlanChange {
  const total = next.length;
  if (!previous || previous.length === 0) return { kind: "created", total };
  const sameSteps =
    previous.length === next.length &&
    previous.every((step, index) => step.step === next[index]!.step);
  if (!sameSteps) return { kind: "revised", total };

  const completed: number[] = [];
  const abandoned: number[] = [];
  let started: number | undefined;
  let reopened = false;
  next.forEach((step, index) => {
    const before = previous[index]!;
    if (before.status === step.status) return;
    const position = index + 1;
    if (step.status === "completed") completed.push(position);
    else if (step.status === "abandoned") abandoned.push(position);
    else if (step.status === "in_progress") started = position;
    if (before.status === "completed" || before.status === "abandoned")
      reopened = true;
  });
  if (reopened) return { kind: "revised", total };
  if (!completed.length && !abandoned.length && started === undefined)
    return { kind: "same" };
  const done = next.filter((step) => step.status === "completed").length;
  if (openSteps(next).length === 0)
    return {
      kind: "finished",
      completed,
      done,
      abandoned: next.filter((step) => step.status === "abandoned").length,
      total,
    };
  return { kind: "progress", completed, abandoned, started, done, total };
}
