import type { AgentEvent } from "@blame/agent-runtime"

import type {
  QuickChat,
  QuickChatAgentRun,
  QuickChatAgentRunUpdate,
  QuickChatUpdate,
} from "@/components/chat/data/quick-chat-data"
import type { UserStoryAgentActivity } from "../../backlog/data/backlog-data.ts"
import {
  agentEventText,
  agentFlowUpdate,
  cancelledAgentRun,
  type AgentFlowUpdate,
  completedAgentRun,
  failedAgentRun,
  terminalAgentRunEvent,
} from "../../backlog/data/agent-flow.ts"

export type QueuedQuickChatAgentUpdate = {
  activities: UserStoryAgentActivity[]
  input: QuickChatUpdate
  run?: QuickChatAgentRun
  runInput: QuickChatAgentRunUpdate
}

const agentCompletionRecoveryGraceMs = 15_000

export function quickChatAgentEventUpdate(
  chat: QuickChat,
  event: AgentEvent,
  preparedFlowUpdate?: AgentFlowUpdate
): QuickChatUpdate {
  const text = agentEventText(event)
  const flowUpdate = preparedFlowUpdate ?? agentFlowUpdate(chat, event)
  if (quickChatExpiredAuthenticationToken(text)) {
    return {
      ...flowUpdate,
      agentLastError: text,
      agentLastEvent: text,
      agentStatus: "Paused",
    }
  }
  if (completedAgentRun(event)) {
    return {
      ...flowUpdate,
      agentLastError: null,
      agentLastEvent: text || "Agent completed.",
      agentStatus: null,
    }
  }
  if (cancelledAgentRun(event)) {
    return {
      ...flowUpdate,
      agentLastError: null,
      agentLastEvent: text || "Agent stopped.",
      agentStatus: null,
    }
  }
  if (quickChatFailedAgentRun(event)) {
    return {
      ...flowUpdate,
      agentLastError: text || "Agent session failed",
      agentLastEvent: text || "Agent session failed",
      agentStatus: null,
    }
  }
  return {
    ...flowUpdate,
    agentLastError:
      event.type === "error" ? text || "Agent session failed" : undefined,
    agentLastEvent: text || event.type,
  }
}

export function quickChatAgentRunEventUpdate(
  input: QuickChatUpdate,
  event: AgentEvent,
  text: string
): QuickChatAgentRunUpdate {
  const update: QuickChatAgentRunUpdate = {}
  if (input.agentActivity) update.agentActivity = input.agentActivity
  if (input.agentActivityUpdates)
    update.agentActivityUpdates = input.agentActivityUpdates
  if (input.agentFinalResponse !== undefined)
    update.finalResponse = input.agentFinalResponse
  if (input.agentUsage !== undefined) update.usage = input.agentUsage
  if (input.agentSessionSummary !== undefined)
    update.sessionSummary = input.agentSessionSummary
  if (completedAgentRun(event)) return completedRunUpdate(update)
  if (cancelledAgentRun(event)) {
    return cancelledRunUpdate(update, text || "Agent stopped.")
  }
  if (quickChatFailedAgentRun(event)) return failedRunUpdate(update, text)
  return update
}

export function immediateQuickChatAgentEvent(event: AgentEvent) {
  return (
    terminalAgentRunEvent(event) ||
    quickChatExpiredAuthenticationToken(agentEventText(event))
  )
}

export function quickChatClineLogPath(workspace: string, sessionId: string) {
  return `${workspace}/.blame/logs/cline-${sessionId}.log`
}

export function quickChatClineLogRelativePath(sessionId: string) {
  return `.blame/logs/cline-${sessionId}.log`
}

export function recoverableQuickChatAgentRun(
  chat: QuickChat,
  now = Date.now()
) {
  if (chat.agentStatus !== "Running" || !chat.workspace) return undefined
  return chat.agentRuns?.findLast((run) => {
    const updatedAt = run.updatedAt ?? run.createdAt
    return (
      run.status === "running" &&
      Boolean(run.clineSessionId ?? chat.clineSessionId) &&
      now - new Date(updatedAt).getTime() >= agentCompletionRecoveryGraceMs
    )
  })
}

export function quickChatExpiredAuthenticationToken(message: string) {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("authentication token") &&
    normalized.includes("invalidated")
  )
}

export function quickChatFailedAgentRun(event: AgentEvent) {
  return failedAgentRun(event)
}

export function quickChatAgentMetadataUpdate(
  input: QuickChatUpdate
): QuickChatUpdate {
  const { agentActivities, agentActivity, agentActivityUpdates, ...metadata } =
    input
  void agentActivities
  void agentActivity
  void agentActivityUpdates
  return metadata
}

export function quickChatAgentRunMetadataUpdate(
  input: QuickChatAgentRunUpdate
): QuickChatAgentRunUpdate {
  const { activities, agentActivity, agentActivityUpdates, ...metadata } = input
  void activities
  void agentActivity
  void agentActivityUpdates
  return metadata
}

export function pendingQuickChatAgentUpdate(
  pending: QueuedQuickChatAgentUpdate | undefined,
  input: QuickChatUpdate,
  run: QuickChatAgentRun | undefined,
  runInput: QuickChatAgentRunUpdate
): QueuedQuickChatAgentUpdate {
  return {
    activities: nextAgentActivities(
      pending?.activities ?? [],
      activityUpdates(input)
    ),
    input: { ...pending?.input, ...input },
    run: pending?.run ?? run,
    runInput: { ...pending?.runInput, ...runInput },
  }
}

export function definedQuickChatUpdate(input: object) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  )
}

function completedRunUpdate(input: QuickChatAgentRunUpdate) {
  return {
    ...input,
    completedAt: new Date().toISOString(),
    status: "completed" as const,
  }
}

function failedRunUpdate(input: QuickChatAgentRunUpdate, text: string) {
  return {
    ...input,
    completedAt: new Date().toISOString(),
    finalResponse: input.finalResponse || text || undefined,
    status: "failed" as const,
  }
}

function cancelledRunUpdate(input: QuickChatAgentRunUpdate, text: string) {
  return {
    ...input,
    completedAt: new Date().toISOString(),
    finalResponse: input.finalResponse || text || undefined,
    status: "cancelled" as const,
  }
}

function nextAgentActivities(
  activities: UserStoryAgentActivity[],
  updates: UserStoryAgentActivity[]
) {
  return updates.reduce(upsertAgentActivity, activities)
}

function activityUpdates(input: QuickChatUpdate) {
  return input.agentActivityUpdates ?? activityUpdateList(input.agentActivity)
}

function activityUpdateList(
  activity: UserStoryAgentActivity | null | undefined
) {
  return activity ? [activity] : []
}

function upsertAgentActivity(
  activities: UserStoryAgentActivity[],
  activity: UserStoryAgentActivity
) {
  const exists = activities.some((item) => item.id === activity.id)
  if (!exists) return [...activities, activity]
  return activities.map((item) => (item.id === activity.id ? activity : item))
}
