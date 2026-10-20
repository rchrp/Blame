// A specialist (consult_specialist) works as a sub-agent. The runtime relays
// its tool calls, messages and reasoning as updates of the consult call; they
// are kept as their own activities, tied to that call, so the conversation
// shows only the specialist's answer and its thread opens on demand.

export const specialistStepUpdateType = "blame.specialist_step"

const threadPrefix = "subagent:"

export type SpecialistStep =
  | {
      id: string
      kind: "tool"
      phase: "started" | "finished" | "failed"
      toolCallId: string
      toolName: string
      input?: unknown
      output?: unknown
      error?: string
    }
  | { id: string; kind: "message" | "reasoning"; text: string }

export function specialistThreadActivityId(
  parentToolCallId: string,
  stepId: string
) {
  return `${threadPrefix}${parentToolCallId}:${stepId}`
}

// Steps of any specialist thread: left out of the main conversation.
export function isSpecialistThreadActivityId(activityId: string) {
  return activityId.startsWith(threadPrefix)
}

export function specialistThreadActivityIds(
  activityIds: readonly string[],
  parentToolCallId: string
) {
  const prefix = `${threadPrefix}${parentToolCallId}:`
  return activityIds.filter((activityId) => activityId.startsWith(prefix))
}

// The specialist's answer, shown on its card in the conversation.
export function specialistResponseActivityId(toolActivityId: string) {
  return `specialist-response-${toolActivityId}`
}

export function isSpecialistResponseActivityId(activityId: string) {
  return activityId.startsWith("specialist-response-")
}

// Reads a relayed step from a tool event payload, if it carries one.
export function specialistStep(
  payload: Record<string, unknown>
): SpecialistStep | undefined {
  const update = record(payload.update ?? record(payload.raw).update)
  if (update.type !== specialistStepUpdateType) return undefined
  const step = record(update.step)
  const id = typeof step.id === "string" ? step.id : undefined
  if (!id) return undefined
  if (step.kind === "tool") {
    if (typeof step.toolCallId !== "string" || typeof step.toolName !== "string")
      return undefined
    const phase =
      step.phase === "finished" || step.phase === "failed" ? step.phase : "started"
    return {
      id,
      kind: "tool",
      phase,
      toolCallId: step.toolCallId,
      toolName: step.toolName,
      input: step.input,
      output: step.output,
      ...(typeof step.error === "string" ? { error: step.error } : {}),
    }
  }
  if (
    (step.kind === "message" || step.kind === "reasoning") &&
    typeof step.text === "string" &&
    step.text.trim()
  )
    return { id, kind: step.kind, text: step.text }
  return undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
