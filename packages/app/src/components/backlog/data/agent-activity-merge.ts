import type { UserStoryAgentActivity } from "./backlog-data.ts"

export function mergeAgentActivities(
  currentActivities: UserStoryAgentActivity[],
  serverActivities: UserStoryAgentActivity[]
) {
  const activities = new Map(currentActivities.map((item) => [item.id, item]))
  serverActivities.forEach((serverActivity) => {
    const currentActivity = activities.get(serverActivity.id)
    activities.set(
      serverActivity.id,
      currentActivity
        ? mergeAgentActivity(currentActivity, serverActivity)
        : serverActivity
    )
  })
  return sortedByCreatedAt([...activities.values()])
}

export function mergeAgentActivity(
  currentActivity: UserStoryAgentActivity,
  serverActivity: UserStoryAgentActivity
) {
  const newestActivity = newestValue(currentActivity, serverActivity)
  const mergedActivity = preserveActivityMetadata(
    currentActivity,
    newestActivity
  )
  if (shouldPreserveStructuredToolDetail(currentActivity, serverActivity)) {
    return { ...mergedActivity, detail: currentActivity.detail }
  }
  if (
    currentActivity.kind !== "message" ||
    serverActivity.kind !== "message" ||
    currentActivity.status !== "running" ||
    serverActivity.status !== "running"
  ) {
    return mergedActivity
  }
  return {
    ...mergedActivity,
    detail:
      longestStreamingPrefix(currentActivity.detail, serverActivity.detail) ??
      mergedActivity.detail,
  }
}

function preserveActivityMetadata(
  currentActivity: UserStoryAgentActivity,
  newestActivity: UserStoryAgentActivity
) {
  return {
    ...newestActivity,
    agentAvatar: newestActivity.agentAvatar ?? currentActivity.agentAvatar,
    agentName: newestActivity.agentName ?? currentActivity.agentName,
    toolCallId: newestActivity.toolCallId ?? currentActivity.toolCallId,
    parentToolCallId:
      newestActivity.parentToolCallId ?? currentActivity.parentToolCallId,
    toolName: newestActivity.toolName ?? currentActivity.toolName,
  }
}

function shouldPreserveStructuredToolDetail(
  currentActivity: UserStoryAgentActivity,
  serverActivity: UserStoryAgentActivity
) {
  return (
    currentActivity.kind === "tool" &&
    serverActivity.kind === "tool" &&
    serverActivity.detailTruncated === true &&
    isJsonObject(currentActivity.detail) &&
    !isJsonObject(serverActivity.detail)
  )
}

function isJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value)
    return Boolean(parsed && typeof parsed === "object")
  } catch {
    return false
  }
}

function longestStreamingPrefix(current: string, server: string) {
  const normalizedCurrent = normalizeLineEndings(current)
  const normalizedServer = normalizeLineEndings(server)
  if (normalizedCurrent.startsWith(normalizedServer)) return current
  if (normalizedServer.startsWith(normalizedCurrent)) return server
  return undefined
}

function newestValue<T extends { updatedAt?: string | null }>(
  currentValue: T,
  serverValue: T
) {
  const currentUpdatedAt = timestamp(currentValue.updatedAt)
  const serverUpdatedAt = timestamp(serverValue.updatedAt)
  if (serverUpdatedAt === undefined) return currentValue
  if (currentUpdatedAt === undefined || serverUpdatedAt >= currentUpdatedAt) {
    return serverValue
  }
  return currentValue
}

function sortedByCreatedAt<T extends { createdAt: string }>(items: T[]) {
  return [...items].sort(
    (left, right) =>
      (timestamp(left.createdAt) ?? 0) - (timestamp(right.createdAt) ?? 0)
  )
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n")
}

function timestamp(value: string | null | undefined) {
  if (!value) return undefined
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : date
}
