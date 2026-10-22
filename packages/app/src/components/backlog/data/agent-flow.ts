import { publicAssetUrl } from "../../../lib/public-asset-url.ts"

import type { AgentEvent } from "@blame/agent-runtime"

import type {
  UserStoryAgentActivity,
  UserStoryAgentUsage,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import {
  compactString,
  compactValue,
  eventPayload,
  numberValue,
  parseDetailRecord,
  recordValue,
  stringValue,
  truncate,
  truncateMiddle,
} from "./agent-flow-values.ts"
import { eventUsage, fileMentions, toolNames } from "./agent-flow-usage.ts"
import {
  specialistResponseActivityId,
  specialistStep,
  specialistThreadActivityId,
  type SpecialistStep,
} from "./specialist-thread.ts"

const maxActivities = 512
const maxActivityDetailLength = 4096
const maxServerActivityDetailLength = 262144
type ActivityInput = Omit<UserStoryAgentActivity, "createdAt" | "updatedAt"> & {
  serverDetail?: string
}
type ActivityKind = UserStoryAgentActivity["kind"]
type ActivityStatus = NonNullable<UserStoryAgentActivity["status"]>
type ActivityUpdate = {
  activities: UserStoryAgentActivity[]
  activity: UserStoryAgentActivity
  activityUpdates: UserStoryAgentActivity[]
}
export type AgentFlowState = {
  agentActivities?: UserStoryAgentActivity[] | null
  agentFinalResponse?: string | null
  agentLastError?: string | null
  agentSessionSummary?: string | null
  agentUsage?: UserStoryAgentUsage | null
}
export type AgentFlowUpdate = Pick<
  UserStoryUpdate,
  | "agentActivities"
  | "agentActivity"
  | "agentActivityUpdates"
  | "agentFinalResponse"
  | "agentSessionSummary"
  | "agentUsage"
>

export function agentFlowUpdate(
  story: AgentFlowState,
  event: AgentEvent
): AgentFlowUpdate {
  const activity = eventActivity(story.agentActivities ?? [], event)
  const nextActivities = activity?.activities ?? story.agentActivities ?? []
  const finalResponse = eventFinalResponse(nextActivities, event)
  const usage = eventUsage(story, event)
  const sessionSummary = eventSessionSummary(story, event)
  const update: AgentFlowUpdate = {}
  if (activity) {
    update.agentActivities = activity.activities
    update.agentActivity = activity.activity
    update.agentActivityUpdates = activity.activityUpdates
  }
  if (finalResponse !== undefined) {
    const finalActivity = finalResponseActivity(
      update.agentActivities ?? story.agentActivities ?? [],
      finalResponse,
      eventImages(event)
    )
    if (finalActivity) {
      update.agentActivities = finalActivity.activities
      update.agentActivity = finalActivity.activity
      update.agentActivityUpdates = appendActivityUpdate(
        update.agentActivityUpdates,
        finalActivity.activity
      )
    }
    update.agentFinalResponse = finalResponse
  }
  if (usage) update.agentUsage = usage
  if (sessionSummary !== undefined) update.agentSessionSummary = sessionSummary
  return update
}

function appendActivityUpdate(
  updates: UserStoryAgentActivity[] | undefined,
  activity: UserStoryAgentActivity
) {
  const current = updates ?? []
  const existingIndex = current.findIndex((item) => item.id === activity.id)
  if (existingIndex === -1) return [...current, activity]
  return current.map((item, index) =>
    index === existingIndex ? activity : item
  )
}

export function shouldPersistAgentEvent(
  event: AgentEvent,
  update: AgentFlowUpdate
) {
  if (event.type === "done" || event.type === "error") return true
  if (
    update.agentActivities ||
    update.agentFinalResponse !== undefined ||
    update.agentUsage ||
    update.agentSessionSummary !== undefined
  )
    return true
  return (
    event.type === "approval" ||
    event.type === "tool" ||
    event.type === "reasoning"
  )
}

export function agentEventText(event: AgentEvent) {
  if (!event.payload || typeof event.payload !== "object") return ""
  if (event.type === "error") return errorEventText(event.payload)
  if (event.type === "tool") return toolEventText(event.payload)
  if (event.type === "approval") return approvalEventText(event.payload)
  if ("text" in event.payload && typeof event.payload.text === "string") {
    return event.payload.text
  }
  if ("message" in event.payload && typeof event.payload.message === "string") {
    return event.payload.message
  }
  if ("error" in event.payload && typeof event.payload.error === "string") {
    return event.payload.error
  }
  return ""
}

export function agentErrorText(value: string): string {
  const text = value.trim()
  const result = text.match(
    /^cline send ended with status ([\w-]+)(?::\s*([\s\S]+)|\.)?$/i
  )
  if (result) {
    return result[2]
      ? agentErrorText(result[2])
      : `Agent session ended with status ${result[1]}.`
  }
  return text.replace(
    /^cline(?:\s+(?:mid-stream\s+)?(?:agent\s+)?error)?\s*:\s*/i,
    ""
  )
}

export function resumableAgentFailure(message: string) {
  return /max[\s_-]?iterations|mistake[\s_-]?limit/i.test(message)
}

function errorEventText(payload: object) {
  const value = payload as Record<string, unknown>
  const error = recordValue(value.error)
  const text =
    stringValue(error.message) ??
    stringValue(value.message) ??
    stringValue(value.error)
  return text ? agentErrorText(text) : ""
}

export function completedAgentRun(event: AgentEvent) {
  if (event.type !== "done") return false
  if (!event.payload || typeof event.payload !== "object") return true
  const reason = doneReason(event.payload as Record<string, unknown>)
  if (!reason) return true
  return completedDoneReason(reason)
}

export function failedAgentRun(event: AgentEvent) {
  if (event.type === "error") return true
  if (event.type !== "done") return false
  if (!event.payload || typeof event.payload !== "object") return false
  const reason = doneReason(event.payload as Record<string, unknown>)
  return reason ? failedDoneReason(reason) : false
}

export function cancelledAgentRun(event: AgentEvent) {
  if (event.type !== "done") return false
  if (!event.payload || typeof event.payload !== "object") return false
  const reason = doneReason(event.payload as Record<string, unknown>)
  if (!reason) return false
  return ["aborted", "cancelled", "canceled"].includes(
    normalizedDoneReason(reason)
  )
}

export function terminalAgentRunEvent(event: AgentEvent) {
  return (
    completedAgentRun(event) ||
    failedAgentRun(event) ||
    cancelledAgentRun(event)
  )
}

function eventActivity(
  activities: UserStoryAgentActivity[],
  event: AgentEvent
) {
  if (event.type === "error") return errorActivities(activities, event)
  if (event.type === "notice" && eventPayload(event).recoverable === true)
    return errorActivities(activities, event)
  if (event.type === "reasoning") return reasoningActivities(activities, event)
  if (event.type === "text") return messageActivities(activities, event)
  if (event.type === "tool") return toolActivities(activities, event)
  if (event.type === "approval") return approvalActivities(activities, event)
  if (event.type === "done")
    return closeRunningActivities(activities, ["message", "reasoning", "tool"])
}

function errorActivities(
  activities: UserStoryAgentActivity[],
  event: AgentEvent
) {
  const payload = eventPayload(event)
  const detail = agentEventText(event) || "Agent session failed."
  const iteration = numberValue(payload.iteration)
  const existing = lastMatchingActivity(
    activities,
    (activity) => activity.kind === "error" && activity.detail === detail
  )
  return upsertActivities(activities, [
    ...(event.type === "error"
      ? closeRunningActivityInputs(activities, ["message", "reasoning", "tool"])
      : []),
    {
      id: existing?.id ?? nextErrorActivityId(activities, iteration),
      kind: "error",
      title: event.type === "error" ? "Agent error" : "Recoverable agent error",
      detail,
      actionUrl: safeErrorActionUrl(stringValue(payload.actionUrl)),
      errorCode: agentErrorCode(payload.code),
      resetAt: stringValue(payload.resetAt),
      status: "failed",
      iteration,
    },
  ])
}

function agentErrorCode(value: unknown) {
  if (
    value === "cline_not_subscribed" ||
    value === "cline_org_subscription_unsupported" ||
    value === "cline_pass_limit" ||
    value === "cline_free_model_limit" ||
    value === "cline_model_not_found"
  ) {
    return value
  }
  return undefined
}

function safeErrorActionUrl(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password) {
      return undefined
    }
    return url.toString()
  } catch {
    return undefined
  }
}

function nextErrorActivityId(
  activities: UserStoryAgentActivity[],
  iteration: number | undefined
) {
  const count = activities.filter(
    (activity) => activity.kind === "error"
  ).length
  return `error-${iteration ?? "session"}-${count + 1}`
}

function reasoningActivities(
  activities: UserStoryAgentActivity[],
  event: AgentEvent
) {
  const payload = eventPayload(event)
  const iteration = numberValue(payload.iteration)
  const phase = streamPhase(payload)
  if (closingStreamPhase(phase)) {
    return closeRunningActivities(activities, ["reasoning"])
  }
  const id = inlineActivityId(activities, "reasoning", iteration)
  const text = reasoningText(activities, id, payload)
  if (!text) return undefined
  return upsertActivities(activities, [
    ...closeRunningActivityInputs(activities, ["message", "tool"]),
    {
      id,
      kind: "reasoning",
      title: iteration ? `Agent reasoning ${iteration}` : "Agent reasoning",
      detail: text,
      serverDetail: text,
      status: "running" as const,
      iteration,
    },
  ])
}

function reasoningText(
  activities: UserStoryAgentActivity[],
  id: string,
  payload: Record<string, unknown>
) {
  const accumulatedText = stringValue(payload.accumulatedText)
  if (accumulatedText !== undefined) return accumulatedText
  const reasoning = stringValue(payload.reasoning)
  if (reasoning !== undefined) return reasoning
  const text = stringValue(payload.text)
  if (text === undefined) return undefined
  const existing = activities.find((activity) => activity.id === id)
  return appendStreamingText(existing?.detail, text)
}

function appendStreamingText(current: string | undefined, next: string) {
  if (!current) return next
  return `${current}${next}`
}

function messageActivities(
  activities: UserStoryAgentActivity[],
  event: AgentEvent
) {
  const payload = eventPayload(event)
  const iteration = numberValue(payload.iteration)
  const phase = streamPhase(payload)
  if (closingStreamPhase(phase)) {
    return closeRunningActivities(activities, ["message"])
  }
  const id = messageActivityId(activities, iteration, payload)
  const text = messageText(activities, id, iteration, payload)
  if (text === undefined || !text.trim()) return undefined
  const messageKind = agentMessageKind()
  return upsertActivities(activities, [
    ...closeRunningActivityInputs(activities, ["reasoning", "tool"]),
    {
      id,
      kind: "message",
      title: messageKind === "final" ? "Agent response" : "Agent message",
      detail: text,
      serverDetail: text,
      status: messageKind === "final" ? "completed" : ("running" as const),
      iteration,
      messageKind,
    },
  ])
}

function messageActivityId(
  activities: UserStoryAgentActivity[],
  iteration: number | undefined,
  payload: Record<string, unknown>
) {
  const active = inlineActivity(activities, "message", iteration)
  if (active) return active.id
  const accumulatedText = stringValue(payload.accumulatedText)
  const lastActivity = activities.at(-1)
  if (
    accumulatedText !== undefined &&
    reusableClosedMessage(lastActivity, iteration, accumulatedText)
  ) {
    return lastActivity.id
  }
  return nextInlineActivityId(activities, "message", iteration)
}

function inlineActivityId(
  activities: UserStoryAgentActivity[],
  kind: "message" | "reasoning",
  iteration: number | undefined
) {
  const active = inlineActivity(activities, kind, iteration)
  if (active) return active.id
  return nextInlineActivityId(activities, kind, iteration)
}

function inlineActivity(
  activities: UserStoryAgentActivity[],
  kind: "message" | "reasoning",
  iteration: number | undefined
) {
  return lastMatchingActivity(
    activities,
    (activity) =>
      activity.kind === kind &&
      activity.status === "running" &&
      sameIteration(activity.iteration, iteration)
  )
}

function nextInlineActivityId(
  activities: UserStoryAgentActivity[],
  kind: "message" | "reasoning",
  iteration: number | undefined
) {
  const label = kind === "message" ? "message" : "reasoning"
  const count = activities.filter(
    (activity) =>
      activity.kind === kind && sameIteration(activity.iteration, iteration)
  ).length
  return `${label}-${iteration ?? "session"}-${count + 1}`
}

function reusableClosedMessage(
  activity: UserStoryAgentActivity | undefined,
  iteration: number | undefined,
  accumulatedText: string
): activity is UserStoryAgentActivity {
  return (
    activity?.kind === "message" &&
    sameIteration(activity.iteration, iteration) &&
    sameStreamingResponse(activity.detail, accumulatedText)
  )
}

function lastMatchingActivity(
  activities: UserStoryAgentActivity[],
  predicate: (activity: UserStoryAgentActivity) => boolean
) {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]
    if (activity && predicate(activity)) return activity
  }
}

function streamPhase(payload: Record<string, unknown>) {
  return stringValue(payload.phase) ?? stringValue(payload.hookEventName)
}

function closingStreamPhase(phase: string | undefined) {
  return (
    phase === "finished" ||
    phase === "content_end" ||
    phase === "end" ||
    phase === "done"
  )
}

function closeRunningActivities(
  activities: UserStoryAgentActivity[],
  kinds: ActivityKind[]
) {
  const inputs = closeRunningActivityInputs(activities, kinds)
  if (!inputs.length) return undefined
  return upsertActivities(activities, inputs)
}

function closeRunningActivityInputs(
  activities: UserStoryAgentActivity[],
  kinds: ActivityKind[]
): ActivityInput[] {
  return activities
    .filter(
      (activity) =>
        activity.status === "running" && kinds.includes(activity.kind)
    )
    .map((activity) => {
      const { createdAt, updatedAt, ...input } = activity
      void createdAt
      void updatedAt
      if (activity.kind === "tool") {
        return {
          ...input,
          status: "failed" as const,
          title: `${toolLabel(activity.toolName ?? "tool")} incomplete`,
        }
      }
      return { ...input, status: "completed" as const }
    })
}

function messageText(
  activities: UserStoryAgentActivity[],
  id: string,
  iteration: number | undefined,
  payload: Record<string, unknown>
) {
  const current = activities.find((activity) => activity.id === id)?.detail
  const accumulatedText = stringValue(payload.accumulatedText)
  if (accumulatedText !== undefined) {
    return currentMessageAccumulatedText(
      activities,
      id,
      iteration,
      accumulatedText
    )
  }
  const text = stringValue(payload.text)
  if (text !== undefined) return appendStreamingText(current, text)
  return stringValue(payload.message)
}

function currentMessageAccumulatedText(
  activities: UserStoryAgentActivity[],
  id: string,
  iteration: number | undefined,
  accumulatedText: string
) {
  const previousText = previousMessageText(activities, id, iteration)
  if (!previousText) return accumulatedText
  const normalizedText = normalizedStreamedMessageLineEndings(accumulatedText)
  const normalizedPreviousText =
    normalizedStreamedMessageLineEndings(previousText)
  const prefixLength = accumulatedPrefixLength(
    normalizedText,
    normalizedPreviousText
  )
  if (prefixLength === undefined) return accumulatedText
  if (!safeAccumulatedPrefixBoundary(normalizedText, prefixLength)) {
    return accumulatedText
  }
  return normalizedText.slice(prefixLength).trimStart()
}

function previousMessageText(
  activities: UserStoryAgentActivity[],
  id: string,
  iteration: number | undefined
) {
  return activities
    .filter(
      (activity) =>
        activity.id !== id &&
        activity.kind === "message" &&
        sameIteration(activity.iteration, iteration)
    )
    .map((activity) => activity.detail)
    .join("")
}

function accumulatedPrefixLength(value: string, prefix: string) {
  if (value.startsWith(prefix)) return prefix.length
  const compactPrefix = prefix.trimEnd()
  if (compactPrefix && value.startsWith(compactPrefix)) {
    return compactPrefix.length
  }
  return undefined
}

function safeAccumulatedPrefixBoundary(value: string, index: number) {
  if (index <= 0) return false
  if (index >= value.length) return true
  return /\s/.test(value[index - 1] ?? "") || /\s/.test(value[index] ?? "")
}

function agentMessageKind(): UserStoryAgentActivity["messageKind"] {
  return "intermediate"
}

function finalResponseActivity(
  activities: UserStoryAgentActivity[],
  finalResponse: string,
  images: UserStoryAgentActivity["images"]
) {
  const existing = finalResponseMessageActivity(activities, finalResponse)
  // Images need a final message to sit on, even when none was streamed.
  if (!existing && !images?.length) return undefined
  const { createdAt, updatedAt, ...activity } = existing ?? {
    createdAt: undefined,
    detail: finalResponse,
    id: "message-final",
    kind: "message" as const,
    title: "Agent response",
    updatedAt: undefined,
  }
  void createdAt
  void updatedAt
  return upsertActivity(activities, {
    ...activity,
    detail: finalResponse,
    serverDetail: finalResponse,
    title: "Agent response",
    messageKind: "final",
    status: "completed" as const,
    ...(images?.length ? { images } : {}),
  })
}

// The screenshots finish_task attached, as the done event carries them.
function eventImages(event: AgentEvent) {
  if (!completedAgentRun(event)) return undefined
  const images = eventPayload(event).images
  if (!Array.isArray(images)) return undefined
  const valid = images.flatMap((image) => {
    const value = recordValue(image)
    const id = stringValue(value.id)
    const caption = stringValue(value.caption)?.trim()
    return id && /^[0-9a-f]{64}$/u.test(id) && caption
      ? [{ caption: caption.slice(0, 160), id }]
      : []
  })
  return valid.length ? valid.slice(0, 8) : undefined
}

function finalResponseMessageActivity(
  activities: UserStoryAgentActivity[],
  finalResponse: string
) {
  const lastActivity = activities.at(-1)
  if (lastActivity?.kind !== "message") return undefined
  if (!sameStreamingResponse(lastActivity.detail, finalResponse)) {
    return undefined
  }
  return lastActivity
}

function sameStreamingResponse(left: string, right: string) {
  const normalizedLeft = normalizedStreamedMessage(left)
  const normalizedRight = normalizedStreamedMessage(right)
  if (!normalizedLeft) return false
  return (
    normalizedLeft === normalizedRight ||
    normalizedRight.startsWith(normalizedLeft) ||
    sameLeadingStreamedMessage(normalizedLeft, normalizedRight)
  )
}

function sameLeadingStreamedMessage(left: string, right: string) {
  const prefixLength = Math.min(left.length, right.length, 80)
  if (prefixLength < 40) return false
  return left.slice(0, prefixLength) === right.slice(0, prefixLength)
}

function normalizedStreamedMessage(value: string) {
  return normalizedStreamedMessageLineEndings(value).trim()
}

function normalizedStreamedMessageLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n")
}

function toolActivities(
  activities: UserStoryAgentActivity[],
  event: AgentEvent
) {
  const payload = eventPayload(event)
  const step = specialistStep(payload)
  if (step) return specialistStepActivities(activities, payload, step)
  const phase = stringValue(payload.phase) ?? stringValue(payload.hookEventName)
  const input = toolActivityInput(activities, payload, phase)
  const message = specialistMessageActivityInput(input, payload)
  return upsertActivities(activities, [
    ...closeRunningActivityInputs(activities, ["message", "reasoning"]),
    input,
    ...(message ? [message] : []),
  ])
}

// One step of a specialist's own work, kept apart from the lead agent's
// activities and tied to its consult call.
function specialistStepActivities(
  activities: UserStoryAgentActivity[],
  payload: Record<string, unknown>,
  step: SpecialistStep
) {
  const parentToolCallId = eventToolCallId(payload, recordValue(payload.toolCall))
  if (!parentToolCallId) return undefined
  const parent = activities.find(
    (activity) => activity.id === `tool-${parentToolCallId}`
  )
  const id = specialistThreadActivityId(parentToolCallId, step.id)
  const owner = {
    iteration: parent?.iteration,
    parentToolCallId,
    ...(parent?.agentName ? { agentName: parent.agentName } : {}),
  }
  if (step.kind !== "tool")
    return upsertActivity(activities, {
      ...owner,
      id,
      kind: step.kind,
      title: step.kind === "message" ? (parent?.agentName ?? "Specialist") : "Reasoning",
      detail: step.text,
      status: "completed",
      ...(step.kind === "message" ? { messageKind: "intermediate" as const } : {}),
    })
  const toolPayload = {
    phase: step.phase,
    toolCall: { id: step.toolCallId, name: step.toolName, input: step.input },
    output: step.output ?? (step.error ? { error: step.error } : undefined),
  }
  const existing = parseDetailRecord(
    activities.find((activity) => activity.id === id)?.detail
  )
  return upsertActivity(activities, {
    ...owner,
    id,
    kind: "tool",
    title: toolTitle(step.toolName, step.phase, toolPayload),
    detail: toolDetail(toolPayload, true, existing),
    serverDetail: toolDetail(toolPayload, false, existing),
    status: toolStatus(step.phase, toolPayload),
    toolCallId: step.toolCallId,
    toolName: step.toolName,
  })
}

function toolActivityInput(
  activities: UserStoryAgentActivity[],
  payload: Record<string, unknown>,
  phase: string | undefined
): ActivityInput {
  const toolCall = recordValue(payload.toolCall)
  const toolCallId = eventToolCallId(payload, toolCall)
  const toolName = eventToolName(payload, toolCall)
  const iteration = numberValue(payload.iteration)
  const id = toolActivityId(activities, toolName, iteration, phase, toolCallId)
  const existing = activities.find((activity) => activity.id === id)
  const existingDetail = parseDetailRecord(existing?.detail)
  const agent = specialistTool(toolName)
    ? specialistInfo(toolName, recordValue(toolCall.input), existing)
    : undefined
  return {
    id,
    kind: "tool",
    title: toolTitle(toolName, phase, payload),
    detail: toolDetail(payload, true, existingDetail),
    serverDetail: toolDetail(payload, false, existingDetail),
    status: toolStatus(phase, payload),
    iteration,
    toolCallId,
    toolName,
    ...(agent ? { agentName: agent.name } : {}),
    ...(agent?.avatar ? { agentAvatar: agent.avatar } : {}),
  }
}

function eventToolCallId(
  payload: Record<string, unknown>,
  toolCall: Record<string, unknown>
) {
  return (
    stringValue(toolCall.toolCallId) ??
    stringValue(toolCall.id) ??
    stringValue(payload.toolCallId)
  )
}

function eventToolName(
  payload: Record<string, unknown>,
  toolCall: Record<string, unknown>
) {
  return (
    stringValue(toolCall.toolName) ??
    stringValue(toolCall.name) ??
    stringValue(payload.toolName) ??
    stringValue(payload.name) ??
    "tool"
  )
}

function toolActivityId(
  activities: UserStoryAgentActivity[],
  toolName: string,
  iteration: number | undefined,
  phase: string | undefined,
  toolCallId: string | undefined
) {
  return toolCallId
    ? `tool-${toolCallId}`
    : (matchingToolId(activities, toolName, iteration, phase) ??
        `tool-${toolName}-${activities.length}`)
}

function matchingToolId(
  activities: UserStoryAgentActivity[],
  toolName: string,
  iteration: number | undefined,
  phase: string | undefined
) {
  return lastMatchingActivity(
    activities,
    (activity) =>
      activity.kind === "tool" &&
      activity.toolName === toolName &&
      activity.iteration === iteration &&
      (toolStatus(phase) === "completed" || activity.status === "running")
  )?.id
}

function approvalActivities(
  activities: UserStoryAgentActivity[],
  event: AgentEvent
) {
  const payload = eventPayload(event)
  const toolName = stringValue(payload.toolName) ?? "tool"
  const id = `approval-${stringValue(payload.id) ?? `${toolName}-${activities.length}`}`
  return upsertActivity(activities, {
    id,
    kind: "approval",
    title: `Tool approval requested: ${toolName}`,
    detail: stringifyDetail(payload.input ?? payload),
    status: "running" as const,
  })
}

function eventFinalResponse(
  activities: UserStoryAgentActivity[],
  event: AgentEvent
) {
  if (!completedAgentRun(event)) return undefined
  const payload = eventPayload(event)
  const text = stringValue(payload.text)
  return text?.trim() || lastMessageResponse(activities)
}

function lastMessageResponse(activities: UserStoryAgentActivity[]) {
  // A specialist's own messages are never the lead agent's answer.
  const lastActivity = activities.findLast(
    (activity) => !activity.parentToolCallId
  )
  if (lastActivity?.kind !== "message") return undefined
  return lastActivity.detail.trim() || undefined
}

function upsertActivity(
  activities: UserStoryAgentActivity[],
  input: ActivityInput
) {
  return upsertActivities(activities, [input])
}

function upsertActivities(
  activities: UserStoryAgentActivity[],
  inputs: ActivityInput[]
): ActivityUpdate {
  const updates: UserStoryAgentActivity[] = []
  const nextActivities = inputs.reduce((currentActivities, input) => {
    const next = upsertActivityValue(currentActivities, input)
    updates.push(next.activity)
    return next.activities
  }, activities)
  return {
    activities: limitActivities(nextActivities),
    activity: updates[updates.length - 1],
    activityUpdates: updates,
  }
}

function upsertActivityValue(
  activities: UserStoryAgentActivity[],
  input: ActivityInput
) {
  const now = new Date().toISOString()
  const { serverDetail, ...activityInput } = input
  const existing = activities.find((activity) => activity.id === input.id)
  const next = existing
    ? { ...existing, ...normalizedActivity(activityInput), updatedAt: now }
    : { ...normalizedActivity(activityInput), createdAt: now }
  const serverActivity = serverDetail ? { ...next, detail: serverDetail } : next
  const nextActivities = existing
    ? activities.map((activity) => (activity.id === input.id ? next : activity))
    : [...activities, next]
  return { activities: nextActivities, activity: serverActivity }
}

function specialistMessageActivityInput(
  toolInput: ActivityInput,
  payload: Record<string, unknown>
): ActivityInput | undefined {
  if (!specialistTool(toolInput.toolName)) return undefined
  if (toolInput.status !== "completed") return undefined
  const text = specialistResponseText(payload.output)
  if (!text) return undefined
  const agent =
    specialistInfo(
      toolInput.toolName,
      recordValue(recordValue(payload.toolCall).input),
      toolInput
    ) ??
    specialistInfoFromResponse(text) ??
    fallbackSpecialistInfo
  return {
    id: specialistResponseActivityId(toolInput.id),
    kind: "message",
    title: agent.name,
    detail: text,
    serverDetail: text,
    status: "completed",
    messageKind: "intermediate",
    iteration: toolInput.iteration,
    agentName: agent.name,
    ...(agent.avatar ? { agentAvatar: agent.avatar } : {}),
  }
}

function specialistResponseText(output: unknown) {
  const outputRecord = recordValue(output)
  const text = stringValue(outputRecord.text)?.trim()
  if (text) return text
  return stringValue(output)?.trim()
}

function specialistInfoFromResponse(response: string) {
  return specialistAgents.find((agent) =>
    agent.responseMatches.some((match) => response.includes(match))
  )
}

function specialistInfo(
  toolName: string | undefined,
  input: Record<string, unknown>,
  existing?: Pick<UserStoryAgentActivity, "agentAvatar" | "agentName">
) {
  if (toolName === "consult_specialist") {
    const specialistId = stringValue(input.specialist)
    const matchedAgent = specialistAgents.find(
      (agent) => agent.id === specialistId
    )
    if (matchedAgent) return matchedAgent
  }
  const systemPrompt = stringValue(input.systemPrompt) ?? ""
  const matchedAgent = specialistAgents.find((agent) =>
    systemPrompt.includes(agent.promptMatch)
  )
  if (matchedAgent) return matchedAgent
  if (!existing?.agentName) return undefined
  return {
    name: existing.agentName,
    ...(existing.agentAvatar ? { avatar: existing.agentAvatar } : {}),
    promptMatch: "",
    responseMatches: [],
  }
}

function specialistTool(toolName: string | undefined) {
  return toolName === "consult_specialist" || toolName === "spawn_agent"
}

const fallbackSpecialistInfo = {
  name: "Agent",
  avatar: undefined,
  responseMatches: [],
}

const specialistAgents = [
  {
    id: "codebase_analyst",
    name: "Codebase Analyst",
    avatar: publicAssetUrl("agents/codebase-analyst.png"),
    promptMatch: "Blame's Codebase Analyst",
    responseMatches: ["## Codebase Analysis"],
  },
  {
    id: "frontend_design",
    name: "Frontend Design Specialist",
    avatar: publicAssetUrl("agents/frontend-design-specialist.png"),
    promptMatch: "Blame's Frontend Design Specialist",
    responseMatches: ["## Frontend Design Review"],
  },
  {
    id: "risk_review",
    name: "Risk & Review Analyst",
    avatar: publicAssetUrl("agents/risk-review-analyst.png"),
    promptMatch: "Blame's Risk & Review Analyst",
    responseMatches: ["## Risk Review"],
  },
  {
    id: "story_analyst",
    name: "Story Analyst",
    avatar: publicAssetUrl("agents/story-analyst.png"),
    promptMatch: "Blame's Story Analyst",
    responseMatches: ["## Story Analysis"],
  },
  {
    id: "test_verification",
    name: "Test & Verification Analyst",
    avatar: publicAssetUrl("agents/test-verification-analyst.png"),
    promptMatch: "Blame's Test & Verification Analyst",
    responseMatches: ["## Verification Plan"],
  },
] as const

function sameIteration(left: number | undefined, right: number | undefined) {
  if (left !== undefined || right !== undefined) return left === right
  return true
}

function toolTitle(
  toolName: string,
  phase: string | undefined,
  payload?: Record<string, unknown>
) {
  const label = toolLabel(toolName)
  if (phase === "started" || phase === "tool_call") return `${label} started`
  if (phase === "progress" || phase === "updated") return `${label} updated`
  if (phase === "failed") return `${label} failed`
  if (phase === "cancelled") return `${label} cancelled`
  const outcome = payload ? toolOutcome(payload) : undefined
  if (outcome === "applied") return `${label} applied`
  if (outcome === "completed") return `${label} completed`
  if (outcome === "skipped") return `${label} skipped`
  if (outcome === "unavailable") return `${label} unavailable`
  if (outcome === "blocked") return `${label} blocked`
  if (outcome === "failed") return `${label} failed`
  if (outcome === "conflict") return `${label} conflict`
  if (outcome === "validation_failed") return `${label} validation failed`
  if (outcome === "infrastructure_error")
    return `${label} infrastructure unavailable`
  return label
}

function toolStatus(
  phase: string | undefined,
  payload?: Record<string, unknown>
): ActivityStatus {
  if (payload && failedToolOutcome(toolOutcome(payload), toolFatal(payload)))
    return "failed"
  if (phase === "finished" || phase === "tool_result") return "completed"
  if (phase === "agent_error" || phase === "failed" || phase === "cancelled")
    return "failed"
  return "running"
}

function toolOutcome(payload: Record<string, unknown>) {
  const output = toolResultEnvelope(payload)
  const data = recordValue(output.data)
  const declared = stringValue(output.outcome) ?? stringValue(data.outcome)
  if (declared === "applied" && data.applied === false) return "blocked"
  return declared
}

function toolFatal(payload: Record<string, unknown>) {
  const output = toolResultEnvelope(payload)
  return output.fatal === true
}

function toolResultEnvelope(payload: Record<string, unknown>) {
  const output = recordValue(payload.output)
  const nested = recordValue(output.output)
  return stringValue(nested.outcome) ? nested : output
}

function failedToolOutcome(outcome: string | undefined, fatal = false) {
  if (outcome === "failed") return fatal
  return false
}

function toolDetail(
  payload: Record<string, unknown>,
  compact: boolean,
  existing: Record<string, unknown>
) {
  const toolCall = recordValue(payload.toolCall)
  const detail = {
    durationMs: payload.durationMs ?? existing.durationMs,
    toolName:
      stringValue(toolCall.name) ??
      stringValue(toolCall.toolName) ??
      existing.toolName,
    input:
      toolCall.input === undefined
        ? existing.input
        : compact
          ? compactValue(toolCall.input)
          : toolCall.input,
    output:
      payload.output === undefined
        ? existing.output
        : compact
          ? compactValue(payload.output)
          : payload.output,
    update:
      payload.update === undefined
        ? existing.update
        : compact
          ? compactValue(payload.update)
          : payload.update,
    hookEventName: payload.hookEventName ?? existing.hookEventName,
  }
  return stringifyDetail(
    detail,
    compact ? maxActivityDetailLength : maxServerActivityDetailLength
  )
}

function toolEventText(payload: object) {
  if ("toolName" in payload && typeof payload.toolName === "string") {
    return toolLabel(payload.toolName)
  }
  if ("name" in payload && typeof payload.name === "string") {
    return toolLabel(payload.name)
  }
  if ("hookEventName" in payload && typeof payload.hookEventName === "string") {
    return `Tool event: ${payload.hookEventName}`
  }
  return "Tool event"
}

function toolLabel(toolName: string) {
  if (toolName === "run_commands") return "Ran terminal command"
  if (toolName === "read_files") return "Read files"
  if (toolName === "search_codebase") return "Searched codebase"
  if (toolName === "apply_patch") return "Edited files"
  if (toolName === "write_file") return "Wrote file"
  if (toolName === "list_files") return "Listed files"
  return humanizeToolName(toolName)
}

function humanizeToolName(toolName: string) {
  return toolName
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function approvalEventText(payload: object) {
  if ("toolName" in payload && typeof payload.toolName === "string") {
    return `Tool approval requested: ${payload.toolName}`
  }
  return "Tool approval requested"
}

function failedDoneReason(reason: string) {
  return [
    "aborted",
    "cancelled",
    "canceled",
    "error",
    "failed",
    "max-iterations",
    "max_iterations",
    "mistake-limit",
    "mistake_limit",
  ].includes(normalizedDoneReason(reason))
}

function completedDoneReason(reason: string) {
  return ["complete", "completed", "done", "success", "succeeded"].includes(
    normalizedDoneReason(reason)
  )
}

function doneReason(payload: Record<string, unknown>) {
  return (
    stringValue(payload.status) ??
    stringValue(payload.reason) ??
    stringValue(payload.finishReason)
  )
}

function normalizedDoneReason(reason: string) {
  return reason.trim().toLowerCase()
}

function stringifyDetail(value: unknown, length = maxActivityDetailLength) {
  const serialized = JSON.stringify(value, undefined, 2)
  if (serialized.length <= length) return serialized
  const bounded = JSON.stringify(
    boundedDetailRecord(value, length),
    undefined,
    2
  )
  if (bounded.length <= length) return bounded
  return JSON.stringify(compactString(serialized), undefined, 2)
}

function boundedDetailRecord(value: unknown, length: number) {
  const entries = Object.entries(recordValue(value))
    .filter(([, entry]) => entry !== undefined)
    .slice(0, 12)
  if (!entries.length) return compactString(String(value))
  const fieldLength = Math.max(
    120,
    Math.floor((length - 512) / entries.length) - 80
  )
  return Object.fromEntries(
    entries.map(([key, entry]) => [key, boundedDetailField(entry, fieldLength)])
  )
}

function boundedDetailField(value: unknown, length: number) {
  const serialized =
    typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))
  if (serialized.length <= length) return value
  return {
    excerpt: truncateMiddle(serialized, length),
    originalLength: serialized.length,
    truncated: true,
  }
}

function normalizedActivity(
  activity: Omit<UserStoryAgentActivity, "createdAt" | "updatedAt">
) {
  return {
    ...activity,
    title: truncate(activity.title, 255),
    detail: truncateMiddle(activity.detail, maxActivityDetailLength),
  }
}

function limitActivities(activities: UserStoryAgentActivity[]) {
  return activities.slice(Math.max(0, activities.length - maxActivities))
}

function eventSessionSummary(story: AgentFlowState, event: AgentEvent) {
  if (event.type !== "done" && event.type !== "error") return undefined
  const activities = story.agentActivities ?? []
  const files = fileMentions(activities)
  const tools = toolNames(activities)
  const status = completedAgentRun(event) ? "completed" : "failed"
  return [
    `Session ${status}.`,
    files.length ? `Files touched or inspected: ${files.join(", ")}.` : "",
    tools.length ? `Tools used: ${tools.join(", ")}.` : "",
    story.agentLastError ? `Last error: ${story.agentLastError}` : "",
    "Resume by inspecting the current git diff before making changes.",
  ]
    .filter(Boolean)
    .join("\n")
}
