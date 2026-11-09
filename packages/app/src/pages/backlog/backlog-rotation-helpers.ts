import {
  type UserStory,
  type UserStoryAgentRun,
  userStoryDisplayId,
  userStoryReadyForAgent,
} from "@/components/backlog/data/backlog-data"
import type { HostDependencyReport, usePlatform } from "@/context/platform"
import type { useRuntimePreference } from "@/lib/runtime-preference"
import { showSystemNotification } from "@/lib/system-notifications"
import type { useCloudAuth } from "@/context/cloud-auth"
import type { useModelSelection } from "@/components/model/model-selection"

const agentCompletionRecoveryGraceMs = 60_000

export function activeAgentRun(story: UserStory, run: UserStoryAgentRun) {
  return story.agentRuns?.find((currentRun) => currentRun.id === run.id)
}

export function reportAgentPersistenceError(error: unknown) {
  console.error("Failed to persist agent update.", error)
}

export type HostDependenciesDialogState = {
  checking: boolean
  report: HostDependencyReport
  runtimeProfile: ReturnType<typeof useRuntimePreference>["profile"]
  workspaceMode: "local-container" | "cloud-mirror" | "direct"
  storyId: string
  storyTitle: string
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

// Agents that may work at the same time, queue starts and resumes alike.
export const maxConcurrentDevelopmentStories = 3

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

export { runningAgentRunsForStory } from "./agent-run-liveness"
import { runningAgentRunsForStory } from "./agent-run-liveness"

export function nextAgentRun(story: UserStory, run: UserStoryAgentRun) {
  return story.agentRuns?.find(
    (candidate) =>
      candidate.id !== run.id &&
      Date.parse(candidate.createdAt) > Date.parse(run.createdAt)
  )
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

