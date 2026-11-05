import type { AgentEvent } from "@blame/agent-runtime"

import {
  cancelledAgentRun,
  completedAgentRun,
  failedAgentRun,
  type AgentFlowUpdate,
} from "../../backlog/data/agent-flow.ts"
import { agentRunFinalization } from "../../backlog/data/agent-run-lifecycle.ts"
import type { UserStoryAgentActivity } from "@/components/backlog/data/backlog-data"
import type {
  AgentConversationComment,
  AgentConversationRun,
} from "@/components/chat/agent-conversation"
import { isProposalActivity } from "../proposals/proposal-tools.ts"

// A conversation kept by the app itself (plan mode, the new-project
// assistant), in the same shape as chats and user stories so it renders
// with the same timeline.

export type LocalAgentConversation = {
  comments: AgentConversationComment[]
  runs: AgentConversationRun[]
  // The runtime session every turn resumes.
  sessionId?: string
  updatedAt: string
}

const maxStoredRuns = 60
const maxStoredDetailLength = 4096

export function emptyLocalConversation(): LocalAgentConversation {
  return { comments: [], runs: [], updatedAt: new Date().toISOString() }
}

export function appendTurn(
  conversation: LocalAgentConversation,
  comment: AgentConversationComment,
  run: AgentConversationRun
): LocalAgentConversation {
  return {
    ...conversation,
    comments: [...conversation.comments, comment],
    runs: [...conversation.runs, run],
    updatedAt: new Date().toISOString(),
  }
}

export function updateRun(
  conversation: LocalAgentConversation,
  runId: string,
  patch: Partial<AgentConversationRun>
): LocalAgentConversation {
  return {
    ...conversation,
    runs: conversation.runs.map((run) =>
      run.id === runId ? { ...run, ...patch } : run
    ),
    updatedAt: new Date().toISOString(),
  }
}

/** Applies one persisted stream snapshot, and the outcome of a last event. */
export function applyStreamSnapshot(
  conversation: LocalAgentConversation,
  runId: string,
  update: AgentFlowUpdate,
  event: AgentEvent,
  stream: Pick<AgentConversationRun, "lastSequenceNumber"> = {}
): LocalAgentConversation {
  const run = conversation.runs.find((item) => item.id === runId)
  if (!run || run.status !== "running") return conversation
  const activities = fullDetailActivities(run.activities ?? [], update)
  const patch: Partial<AgentConversationRun> = {
    ...stream,
    activities,
    ...(update.agentFinalResponse !== undefined
      ? { finalResponse: update.agentFinalResponse }
      : {}),
    ...(update.agentUsage !== undefined ? { usage: update.agentUsage } : {}),
  }
  const status = terminalStatus(event)
  if (!status) return updateRun(conversation, runId, patch)
  const completedAt = new Date().toISOString()
  const finalization = agentRunFinalization(
    activities,
    {},
    { completedAt, status }
  )
  return updateRun(conversation, runId, {
    ...patch,
    activities: finalization?.activities ?? activities,
    completedAt,
    status,
  })
}

/** Ends a turn that did not reach the agent or lost its stream. */
export function endRun(
  conversation: LocalAgentConversation,
  runId: string,
  status: "cancelled" | "failed",
  message: string
): LocalAgentConversation {
  const run = conversation.runs.find((item) => item.id === runId)
  if (!run || run.status !== "running") return conversation
  const completedAt = new Date().toISOString()
  const finalization = agentRunFinalization(
    run.activities ?? [],
    {},
    { completedAt, status }
  )
  return updateRun(conversation, runId, {
    activities: finalization?.activities ?? run.activities,
    completedAt,
    finalResponse: run.finalResponse ?? message,
    status,
  })
}

/**
 * Turns a stored conversation left running: the app follows them again when
 * the desktop still runs their session. Only the latest turn can still run;
 * earlier ones were cut off by a later turn.
 */
export function resumableRuns(conversation: LocalAgentConversation) {
  const latest = conversation.runs.at(-1)
  return latest?.status === "running" || latest?.status === "pending"
    ? [latest]
    : []
}

/** Running turns that cannot be followed again end as interrupted. */
export function settleInterruptedRuns(
  conversation: LocalAgentConversation,
  keep: ReadonlySet<string> = new Set()
) {
  return conversation.runs.reduce(
    (current, run) =>
      (run.status === "running" || run.status === "pending") &&
      !keep.has(run.id)
        ? endRun(
            { ...current, runs: markRunning(current.runs, run.id) },
            run.id,
            "cancelled",
            "The agent was interrupted."
          )
        : current,
    conversation
  )
}

export function loadLocalConversation(key: string | undefined) {
  if (!key) return emptyLocalConversation()
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return emptyLocalConversation()
    const parsed = JSON.parse(raw) as Partial<LocalAgentConversation>
    if (!Array.isArray(parsed.comments) || !Array.isArray(parsed.runs))
      return emptyLocalConversation()
    const conversation = {
      comments: parsed.comments,
      runs: parsed.runs,
      sessionId:
        typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    }
    // The latest turn stays running until the app checks its session.
    const resumable = new Set(resumableRuns(conversation).map((run) => run.id))
    return settleInterruptedRuns(conversation, resumable)
  } catch {
    return emptyLocalConversation()
  }
}

export function saveLocalConversation(
  key: string | undefined,
  conversation: LocalAgentConversation
) {
  if (!key) return
  try {
    if (!conversation.runs.length) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(storable(conversation)))
  } catch {
    // Storage is a convenience: the conversation still works for now.
  }
}

// Keeps proposals in full (they are the cards); other steps as the timeline
// shows them when collapsed.
function storable(conversation: LocalAgentConversation) {
  const runs = conversation.runs.slice(-maxStoredRuns)
  const messageIds = new Set(runs.map((run) => run.messageId))
  return {
    ...conversation,
    comments: conversation.comments
      .filter((comment) => messageIds.has(comment.id))
      .map(({ fileAttachments, ...comment }) => ({
        ...comment,
        fileAttachments: fileAttachments?.map((file) => ({
          ...file,
          content: undefined,
        })),
      })),
    runs: runs.map((run) => ({
      ...run,
      activities: run.activities?.map(storableActivity),
    })),
  }
}

function storableActivity(activity: UserStoryAgentActivity) {
  if (
    isProposalActivity(activity) ||
    activity.detail.length <= maxStoredDetailLength
  )
    return activity
  return {
    ...activity,
    detail: activity.detail.slice(0, maxStoredDetailLength),
    detailTruncated: true,
    originalDetailLength: activity.detail.length,
  }
}

// The stream sends every activity compacted and the changed one in full;
// keep the full copy of each, as the chat and story servers do.
function fullDetailActivities(
  current: UserStoryAgentActivity[],
  update: AgentFlowUpdate
) {
  const known = new Map(current.map((activity) => [activity.id, activity]))
  const full = update.agentActivity
  const activities = update.agentActivities ?? current
  return activities.map((activity) =>
    activity.id === full?.id
      ? full
      : (keepDetail(known.get(activity.id), activity) ?? activity)
  )
}

function keepDetail(
  previous: UserStoryAgentActivity | undefined,
  next: UserStoryAgentActivity
) {
  if (!previous || previous.detail.length <= next.detail.length)
    return undefined
  return { ...next, detail: previous.detail }
}

function terminalStatus(event: AgentEvent) {
  if (cancelledAgentRun(event)) return "cancelled" as const
  if (failedAgentRun(event)) return "failed" as const
  if (completedAgentRun(event)) return "completed" as const
  return undefined
}

function markRunning(runs: AgentConversationRun[], runId: string) {
  return runs.map((run) =>
    run.id === runId ? { ...run, status: "running" as const } : run
  )
}
