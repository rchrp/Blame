import type { AgentEvent } from "@blame/agent-runtime"

import {
  agentEventText,
  agentFlowUpdate,
  cancelledAgentRun,
  completedAgentRun,
  failedAgentRun,
  resumableAgentFailure,
  terminalAgentRunEvent,
  type AgentFlowState,
  type AgentFlowUpdate,
} from "./agent-flow.ts"

import { boundedAgentMessage } from "./agent-update-limits.ts"

import type {
  UserStory,
  UserStoryAgentActivity,
  UserStoryAgentRun,
  UserStoryAgentRunUpdate,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"

export type QueuedAgentUpdate = {
  activities: UserStoryAgentActivity[]
  input: UserStoryUpdate
  run?: UserStoryAgentRun
  runInput: UserStoryAgentRunUpdate
}

export function definedUpdate(input: object) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  )
}

export function pendingAgentUpdate(
  pending: QueuedAgentUpdate | undefined,
  input: UserStoryUpdate,
  run: UserStoryAgentRun | undefined,
  runInput: UserStoryAgentRunUpdate
): QueuedAgentUpdate {
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

function nextAgentActivities(
  activities: UserStoryAgentActivity[],
  updates: UserStoryAgentActivity[]
) {
  return updates.reduce(upsertAgentActivity, activities)
}

export function activityUpdates(input: UserStoryUpdate) {
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

export function agentMetadataUpdate(input: UserStoryUpdate): UserStoryUpdate {
  const { agentActivities, agentActivity, agentActivityUpdates, ...metadata } =
    input
  void agentActivities
  void agentActivity
  void agentActivityUpdates
  return metadata
}

export function pausedAgentUpdate(input: UserStoryUpdate) {
  return input.status === "in-progress" && input.agentStatus === "Paused"
}

export function agentRunMetadataUpdate(
  input: UserStoryAgentRunUpdate
): UserStoryAgentRunUpdate {
  const { activities, agentActivity, agentActivityUpdates, ...metadata } = input
  void activities
  void agentActivity
  void agentActivityUpdates
  return metadata
}

export function agentRunEventUpdate(
  input: UserStoryUpdate,
  event: AgentEvent,
  text: string
): UserStoryAgentRunUpdate {
  const update: UserStoryAgentRunUpdate = {}
  if (input.agentActivity) update.agentActivity = input.agentActivity
  if (input.agentActivityUpdates)
    update.agentActivityUpdates = input.agentActivityUpdates
  if (input.agentFinalResponse !== undefined)
    update.finalResponse = input.agentFinalResponse
  if (input.agentUsage !== undefined) update.usage = input.agentUsage
  if (input.agentSessionSummary !== undefined)
    update.sessionSummary = input.agentSessionSummary
  if (completedAgentRun(event)) {
    update.status = "completed"
    update.completedAt = new Date().toISOString()
  } else if (cancelledAgentRun(event)) {
    update.status = "cancelled"
    update.completedAt = new Date().toISOString()
    if (!update.finalResponse && text) update.finalResponse = text
  } else if (failedAgentRun(event)) {
    update.status = "failed"
    update.completedAt = new Date().toISOString()
    if (!update.finalResponse && text) update.finalResponse = text
  }
  return update
}

export function immediateAgentEvent(event: AgentEvent) {
  return (
    terminalAgentRunEvent(event) ||
    expiredAuthenticationToken(agentEventText(event))
  )
}

export function agentEventUpdate(
  story: UserStory,
  event: AgentEvent,
  preparedFlowUpdate?: AgentFlowUpdate
): UserStoryUpdate {
  const text = agentEventText(event)
  const flowUpdate = preparedFlowUpdate ?? agentFlowUpdate(story, event)
  if (expiredAuthenticationToken(text)) {
    return {
      ...flowUpdate,
      agentLastError: boundedAgentMessage(text, "Agent authentication failed"),
      agentLastEvent: boundedAgentMessage(text, "Agent authentication failed"),
      agentStatus: "Paused",
    }
  }
  if (completedAgentRun(event)) {
    return {
      ...flowUpdate,
      agentLastError: null,
      agentLastEvent: "Agent completed. Ready for review.",
      agentStatus: null,
      status: "in-review",
    }
  }
  if (cancelledAgentRun(event)) {
    return {
      ...flowUpdate,
      agentLastError: null,
      agentLastEvent: boundedAgentMessage(text, "Agent stopped."),
      agentStatus: null,
      status: "in-review",
    }
  }
  if (failedAgentRun(event)) {
    const resumable = resumableAgentFailure(text)
    return {
      ...flowUpdate,
      agentLastError: boundedAgentMessage(text, "Agent session failed"),
      agentLastEvent: boundedAgentMessage(text, "Agent session failed"),
      agentStatus: resumable ? "Paused" : null,
      status: resumable ? "in-progress" : "in-review",
    }
  }
  return {
    ...flowUpdate,
    agentLastError:
      event.type === "error"
        ? boundedAgentMessage(text, "Agent session failed")
        : undefined,
    agentLastEvent: boundedAgentMessage(text, event.type),
  }
}

export function expiredAuthenticationToken(message: string) {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("authentication token") &&
    normalized.includes("invalidated")
  )
}

// Scoped to the run: once a run failed to authenticate its later events
// are ignored, but a restarted run of the same story is followed again.
export function agentAuthenticationErrorKey(
  story: Pick<UserStory, "id">,
  run?: Pick<UserStoryAgentRun, "id">
) {
  return `${story.id}:${run?.id ?? "story"}:expired-authentication-token`
}

// What a run's stream starts from: the run's own saved state, never the
// story's, which may still hold an earlier run's.
export function runFlowState(run: UserStoryAgentRun): AgentFlowState {
  return {
    agentActivities: run.activities,
    agentFinalResponse: run.finalResponse,
    agentSessionSummary: run.sessionSummary,
    agentUsage: run.usage,
  }
}
