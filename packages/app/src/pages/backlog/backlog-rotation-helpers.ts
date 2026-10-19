import {
  type UserStory,
  type UserStoryAgentActivity,
  type UserStoryAgentRun,
  type UserStoryAgentRunUpdate,
  userStoryDisplayId,
  userStoryReadyForAgent,
  type UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import type { HostDependencyReport, usePlatform } from "@/context/platform"
import type { useRuntimePreference } from "@/lib/runtime-preference"
import type { AgentEvent } from "@blame/agent-runtime"
import {
  cancelledAgentRun,
  completedAgentRun,
  failedAgentRun,
} from "@/components/backlog/data/agent-flow"
import { showSystemNotification } from "@/lib/system-notifications"
import type { useCloudAuth } from "@/context/cloud-auth"
import type { useModelSelection } from "@/components/model/model-selection"
import { taskComplexityBucket } from "@blame/agent-runtime/telemetry-cohorts"

const agentCompletionRecoveryGraceMs = 60_000

export function activeStory(story: UserStory, stories: UserStory[]) {
  return stories.find((currentStory) => currentStory.id === story.id) ?? story
}

export function activeAgentRun(story: UserStory, run: UserStoryAgentRun) {
  return story.agentRuns?.find((currentRun) => currentRun.id === run.id)
}

export function reportAgentPersistenceError(error: unknown) {
  console.error("Failed to persist agent update.", error)
}

export type QueuedAgentUpdate = {
  activities: UserStoryAgentActivity[]
  input: UserStoryUpdate
  run?: UserStoryAgentRun
  runInput: UserStoryAgentRunUpdate
}

export type PendingAgentUpdate = QueuedAgentUpdate & {
  timer: number
}

export type HostDependenciesDialogState = {
  checking: boolean
  report: HostDependencyReport
  runtimeProfile: ReturnType<typeof useRuntimePreference>["profile"]
  storyId: string
  storyTitle: string
}

export function clearPendingAgentUpdates(updates: Map<string, PendingAgentUpdate>) {
  updates.forEach((update) => window.clearTimeout(update.timer))
  updates.clear()
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
  update: UserStoryUpdate,
  event: AgentEvent,
  text: string
): UserStoryAgentRunUpdate {
  const input: UserStoryAgentRunUpdate = {}
  if (update.agentActivity) input.agentActivity = update.agentActivity
  if (update.agentActivityUpdates)
    input.agentActivityUpdates = update.agentActivityUpdates
  if (update.agentUsage) input.usage = update.agentUsage
  if (update.agentFinalResponse !== undefined)
    input.finalResponse = update.agentFinalResponse
  if (update.agentSessionSummary !== undefined)
    input.sessionSummary = update.agentSessionSummary
  if (completedAgentRun(event)) {
    input.status = "completed"
    input.completedAt = new Date().toISOString()
  }
  if (cancelledAgentRun(event)) {
    input.status = "cancelled"
    input.finalResponse = update.agentFinalResponse ?? text
    input.completedAt = new Date().toISOString()
  }
  if (failedAgentRun(event) && !cancelledAgentRun(event)) {
    input.status = "failed"
    input.finalResponse = update.agentFinalResponse ?? text
    input.completedAt = new Date().toISOString()
  }
  return input
}

export function notifyCommentResponseCompleted(
  story: UserStory,
  run: UserStoryAgentRun | undefined,
  platform: ReturnType<typeof usePlatform>
) {
  if (!run?.commentId) return
  void showSystemNotification(platform, {
    body: `${userStoryDisplayId(story)} · ${story.title}`,
    target: { pathname: "/backlog", storyId: story.id },
    title: "Agent replied to a comment",
  })
}

export function runningStories(stories: UserStory[]) {
  return stories.filter(
    (story) => story.status === "in-progress" && story.agentStatus !== "Paused"
  ).length
}

export function queuedStories(
  stories: UserStory[],
  startingStoryIds: Set<string>,
  blockedStories: Map<string, number>
) {
  const now = Date.now()
  return stories
    .filter(
      (story) =>
        userStoryReadyForAgent(story) &&
        !startingStoryIds.has(story.id) &&
        !blocked(story.id, blockedStories, now)
    )
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    )
}

function blocked(
  storyId: string,
  blockedStories: Map<string, number>,
  now: number
) {
  const retryAt = blockedStories.get(storyId)
  if (!retryAt) return false
  if (retryAt > now) return true
  blockedStories.delete(storyId)
  return false
}

export function projectInitializing(status: string | undefined) {
  return !status || status === "pending" || status === "running"
}

export function rotationBlocker(
  authStatus: ReturnType<typeof useCloudAuth>["status"],
  platform: ReturnType<typeof usePlatform>,
  model: ReturnType<typeof useModelSelection>["currentModel"]
) {
  if (authStatus !== "authenticated") return "Authentication is required."
  if (!platform.agent) return "Desktop agent runtime is not available."
  if (!platform.workspace?.createWorktree)
    return "Desktop worktree runtime is not available."
  if (!platform.workspace.checkHostDependencies)
    return "Desktop host dependency checks are not available."
  if (!platform.workspace.prepareProjectPreview)
    return "Desktop preview preparation is not available."
  if (!model) return "Choose a model before starting queued user stories."
  return undefined
}

export function recoverableAgentRun(story: UserStory) {
  return runningAgentRunsForStory(story).findLast(
    (run) =>
      !run.finalResponse &&
      staleAgentRun(run) &&
      Boolean(run.clineSessionId ?? story.clineSessionId)
  )
}

export function runningAgentRunsForStory(story: UserStory) {
  const runs = new Map(
    (story.runningAgentRuns ?? []).map((run) => [run.id, run])
  )
  story.agentRuns?.forEach((run) => runs.set(run.id, run))
  return [...runs.values()].filter((run) => run.status === "running")
}

export function nextAgentRun(story: UserStory, run: UserStoryAgentRun) {
  return story.agentRuns?.find(
    (candidate) =>
      candidate.id !== run.id &&
      Date.parse(candidate.createdAt) > Date.parse(run.createdAt)
  )
}

export function runFlowState(run: UserStoryAgentRun) {
  return {
    agentActivities: run.activities,
    agentFinalResponse: run.finalResponse,
    agentSessionSummary: run.sessionSummary,
    agentUsage: run.usage,
  }
}

function staleAgentRun(run: UserStoryAgentRun) {
  return staleAgentRunAge(run) >= agentCompletionRecoveryGraceMs
}

export function staleAgentRunAge(run: UserStoryAgentRun) {
  const updatedAt = run.updatedAt ?? run.createdAt
  return Math.max(0, Date.now() - new Date(updatedAt).getTime())
}

export function recoveredMessageCount(value: unknown) {
  if (Array.isArray(value)) return value.length
  if (!value || typeof value !== "object") return 0
  const messages = (value as Record<string, unknown>).messages
  return Array.isArray(messages) ? messages.length : 0
}

function storyTaskComplexity(story: UserStory) {
  const promptLength = story.title.length + story.summary.length
  const attachmentCount =
    (story.codeSelectionAttachments?.length ?? 0) +
    (story.fileAttachments?.length ?? 0)
  return taskComplexityBucket(promptLength, attachmentCount)
}

export function storyTelemetryCohorts(
  story: UserStory,
  modelId: string | null | undefined,
  providerId: string | null | undefined
) {
  if (!modelId || !providerId) return undefined
  return {
    agentStrategy: "multi_agent" as const,
    modelId,
    providerId,
    taskComplexityBucket: storyTaskComplexity(story),
  }
}

export function clineLogPath(worktree: string, sessionId: string) {
  return `${worktree}/.blame/logs/cline-${sessionId}.log`
}

export function clineLogRelativePath(sessionId: string) {
  return `.blame/logs/cline-${sessionId}.log`
}

export function activePreviewStory(story: UserStory) {
  return (
    (story.status === "in-progress" || story.status === "in-review") &&
    Boolean(story.worktree) &&
    Boolean(story.previewUrl || story.runConfigurationId)
  )
}

export function previewRecoveryStateKey(stories: UserStory[]) {
  return stories
    .filter(activePreviewStory)
    .map((story) =>
      [
        story.id,
        story.status,
        story.worktree,
        story.workspaceMode,
        story.previewUrl,
        story.runConfigurationId,
      ].join("\0")
    )
    .sort()
    .join("\n")
}

export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Unable to start queued user story."
}

export function expiredAuthenticationToken(message: string) {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("authentication token") &&
    normalized.includes("invalidated")
  )
}

export function agentAuthenticationErrorKey(story: UserStory) {
  return `${story.id}:expired-authentication-token`
}

export { directQueueNotice, directStorySlots } from "./direct-story-queue"
