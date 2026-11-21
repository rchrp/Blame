import { parsePlan } from "@blame/engine-client/transcript"
import type { PlanChange } from "@blame/engine-client/transcript"

import { record } from "./tool-call-values.ts"
import type { ToolCallSource, ToolCallView } from "./tool-call-view.ts"

// An update of the agent's plan, as the one line it is in the conversation:
// what changed ("Step 3 done", "Plan revised"), never the tool call. The
// pinned plan above the composer holds the list itself.

/** What the call changed, as `transcriptConversation` left it in the detail. */
function changeOf(detail: string): PlanChange | undefined {
  try {
    const change = record(record(JSON.parse(detail)).planChange)
    return typeof change.kind === "string"
      ? (change as unknown as PlanChange)
      : undefined
  } catch {
    return undefined
  }
}

export function describePlan(source: ToolCallSource): ToolCallView {
  const steps = parsePlan(source.input as never) ?? []
  const change = changeOf(source.detail)
  const refused =
    typeof source.output === "string" &&
    source.output.startsWith("Plan not updated")
  const view = (
    verb: string,
    rest: Partial<ToolCallView> = {}
  ): ToolCallView => ({
    family: "plan",
    verb,
    chips: [],
    bodies: [],
    failed: false,
    ...rest,
  })

  if (source.running) return view("Updating plan")
  if (refused)
    return view("Plan update refused", {
      failed: true,
      bodies: [{ type: "error", message: String(source.output) }],
    })
  const outline: ToolCallView["bodies"] = steps.length
    ? [{ type: "list", label: "Plan", items: steps.map(outlineItem) }]
    : []
  const count = (total: number) => ({
    label: `${total} ${total === 1 ? "step" : "steps"}`,
  })

  switch (change?.kind) {
    case "created":
      return view("Plan set", { chips: [count(change.total)], bodies: outline })
    case "revised":
      return view("Plan revised", {
        chips: [count(change.total)],
        bodies: outline,
      })
    case "finished":
      return view("Plan complete", {
        chips: [
          { label: `${change.done}/${change.total}` },
          ...(change.abandoned
            ? [{ label: `${change.abandoned} abandoned`, tone: "warning" as const }]
            : []),
        ],
        bodies: outline,
      })
    case "progress": {
      const progress = { label: `${change.done}/${change.total}` }
      if (change.completed.length) {
        const only = change.completed.length === 1 ? change.completed[0]! : 0
        return view(`${stepNumbers(change.completed)} done`, {
          ...(only ? { target: { text: steps[only - 1]?.step ?? "" } } : {}),
          chips: [
            progress,
            ...(change.abandoned.length
              ? [
                  {
                    label: `${change.abandoned.length} abandoned`,
                    tone: "warning" as const,
                  },
                ]
              : []),
          ],
          bodies: abandonedReasons(steps, change.abandoned),
        })
      }
      if (change.abandoned.length)
        return view(`${stepNumbers(change.abandoned)} abandoned`, {
          target:
            change.abandoned.length === 1
              ? { text: steps[change.abandoned[0]! - 1]?.step ?? "" }
              : undefined,
          chips: [progress],
          bodies: abandonedReasons(steps, change.abandoned),
        })
      if (change.started)
        return view(`Step ${change.started} started`, {
          target: { text: steps[change.started - 1]?.step ?? "" },
          chips: [progress],
        })
      return view("Plan updated", { chips: [progress] })
    }
    default:
      return view("Plan updated", {
        chips: steps.length ? [count(steps.length)] : [],
        bodies: outline,
      })
  }
}

/** "Step 3", "Steps 2–3", "Steps 2–3, 5". */
export function stepNumbers(positions: readonly number[]): string {
  const runs: string[] = []
  for (let index = 0; index < positions.length; ) {
    let end = index
    while (positions[end + 1] === positions[end]! + 1) end++
    runs.push(
      end > index
        ? `${positions[index]}–${positions[end]}`
        : String(positions[index])
    )
    index = end + 1
  }
  return `${positions.length === 1 ? "Step" : "Steps"} ${runs.join(", ")}`
}

function abandonedReasons(
  steps: ReturnType<typeof parsePlan> & object,
  positions: readonly number[]
): ToolCallView["bodies"] {
  const items = positions.flatMap((position) => {
    const step = steps[position - 1]
    return step?.reason ? [`${step.step}: ${step.reason}`] : []
  })
  return items.length ? [{ type: "list", label: "Reason", items }] : []
}

function outlineItem(
  step: NonNullable<ReturnType<typeof parsePlan>>[number],
  index: number
) {
  const suffix =
    step.status === "completed"
      ? " · done"
      : step.status === "in_progress"
        ? " · in progress"
        : step.status === "abandoned"
          ? ` · abandoned${step.reason ? `: ${step.reason}` : ""}`
          : ""
  return `${index + 1}. ${step.step}${suffix}`
}

/**
 * A finish the engine refused because the plan still has open steps: said as
 * that, with the steps, not as the task wrapped up.
 */
export function describeOpenPlanRefusal(
  source: ToolCallSource
): ToolCallView | undefined {
  const text = typeof source.output === "string" ? source.output : undefined
  if (!text?.includes("the plan still has open steps")) return undefined
  const open = text
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2))
  return {
    family: "finish",
    verb: "Finish refused",
    target: {
      text: `${open.length} plan ${open.length === 1 ? "step" : "steps"} still open`,
    },
    chips: [],
    bodies: open.length ? [{ type: "list", label: "Still open", items: open }] : [],
    failed: true,
  }
}
