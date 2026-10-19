export type BacklogColumnId =
  | "backlog"
  | "ready"
  | "in-progress"
  | "in-review"
  | "done"
  | "discarded"

export type BacklogAction =
  | "Send to Dev Agent"
  | "Discard"
  | "Dequeue"
  | "Open Worktree"
  | "Open Preview"
  | "Stop Agent"
  | "Unpause Agent"
  | "View Diff"
  | "View Files"
  | "View Terminal"
  | "Request Changes"
  | "Reject"
  | "Approve & Merge"
  | "Use Context"
  | "Rework"
  | "Delete Permanently"

export type UserStoryPriority = "Low" | "Medium" | "High"
export type UserStoryAgentStatus = "Running" | "Paused"
export type UserStoryAgentErrorCode =
  | "cline_not_subscribed"
  | "cline_org_subscription_unsupported"
  | "cline_pass_limit"
  | "cline_free_model_limit"
  | "cline_model_not_found"
export type UserStoryAgentUsage = {
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: number
  inputTokens: number
  outputTokens: number
  totalCacheReadTokens?: number
  totalCacheWriteTokens?: number
  totalCost?: number
  totalInputTokens: number
  totalOutputTokens: number
}
export type UserStoryAgentActivity = {
  id: string
  kind: "reasoning" | "message" | "tool" | "approval" | "notice" | "error"
  title: string
  detail: string
  actionUrl?: string
  errorCode?: UserStoryAgentErrorCode
  resetAt?: string
  status?: "running" | "completed" | "failed"
  iteration?: number
  messageKind?: "intermediate" | "final"
  agentName?: string
  agentAvatar?: string
  toolCallId?: string
  toolName?: string
  detailArtifact?: string
  detailTruncated?: boolean
  originalDetailLength?: number
  createdAt: string
  updatedAt?: string
}

export type UserStoryCodeSelectionAttachment = {
  id: string
  content: string
  endLine: number
  path: string
  startLine: number
}

export type UserStoryFileAttachment = {
  id: string
  aiContextMarkdown?: string
  content?: string
  downloadUrl?: string
  name: string
  size: number
  type: string
}

export type UserStoryAgentRunKind = "initial" | "change-request" | "resume"
export type UserStoryAgentRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
export type AgentPersistenceEvent = {
  createdAt: string
  eventId: string
  eventType: string
  executionId: string
  runId: string
  sequenceNumber: number
  sessionId: string
}
export type UserStoryAgentRunTerminalStatus = Exclude<
  UserStoryAgentRunStatus,
  "pending" | "running"
>
export type UserStoryAgentRun = {
  id: string
  userStoryId: string
  commentId?: string | null
  kind: UserStoryAgentRunKind
  clineSessionId?: string | null
  executionId?: string | null
  // The model that answered this turn; it can differ between comments.
  providerId?: string | null
  modelId?: string | null
  reasoningEffort?: string | null
  checkpointRunCount?: number | null
  diffEndRef?: string | null
  status: UserStoryAgentRunStatus
  activities?: UserStoryAgentActivity[] | null
  finalResponse?: string | null
  usage?: UserStoryAgentUsage | null
  sessionSummary?: string | null
  completedAt?: string | null
  createdAt: string
  updatedAt?: string | null
  lastSequenceNumber?: number | null
}

export type UserStoryComment = {
  id: string
  userStoryId: string
  body: string
  codeSelectionAttachments?: UserStoryCodeSelectionAttachment[] | null
  fileAttachments?: UserStoryFileAttachment[] | null
  author: string
  createdAt: string
  updatedAt?: string | null
}

export type UserStory = {
  id: string
  projectId: string
  storyNumber: number
  title: string
  summary: string
  codeSelectionAttachments?: UserStoryCodeSelectionAttachment[] | null
  fileAttachments?: UserStoryFileAttachment[] | null
  fileAttachmentUploadPending?: boolean
  fileAttachmentUploadError?: string
  fileAttachmentUploadStatus?: "uploading" | "failed"
  status: BacklogColumnId
  priority: UserStoryPriority
  owner: string
  branch?: string | null
  previewUrl?: string | null
  runConfigurationId?: string | null
  worktree?: string | null
  workspaceMode?: "local-container" | "cloud-mirror" | "direct" | null
  // Where the person chose to run it (kept across requeues). Null on
  // stories made before the choice was per story: the account default.
  runMode?: "local-container" | "vercel-compose" | "direct" | null
  agentStatus?: UserStoryAgentStatus | null
  activeAgentRunId?: string | null
  clineSessionId?: string | null
  agentProviderId?: string | null
  agentModelId?: string | null
  agentLastEvent?: string | null
  agentLastError?: string | null
  agentActivities?: UserStoryAgentActivity[] | null
  agentFinalResponse?: string | null
  agentUsage?: UserStoryAgentUsage | null
  agentSessionSummary?: string | null
  agentRuns?: UserStoryAgentRun[]
  runningAgentRuns?: UserStoryAgentRun[]
  mergedAt?: string | null
  mergeCommit?: string | null
  baseCommit?: string | null
  discardedReason?: string | null
  comments?: UserStoryComment[]
  createdAt: string
  updatedAt?: string | null
}

export type UserStoryDraft = {
  projectId: string
  title: string
  summary: string
  codeSelectionAttachments?: UserStoryCodeSelectionAttachment[] | null
  fileAttachments?: UserStoryFileAttachment[] | null
  fileAttachmentUploadPending?: boolean
  status?: BacklogColumnId
  priority?: UserStoryPriority
  owner?: string
  runMode?: UserStory["runMode"]
}

export type UserStoryUpdate = Partial<
  Pick<
    UserStory,
    | "projectId"
    | "title"
    | "summary"
    | "codeSelectionAttachments"
    | "fileAttachments"
    | "fileAttachmentUploadPending"
    | "status"
    | "priority"
    | "owner"
    | "branch"
    | "previewUrl"
    | "runConfigurationId"
    | "worktree"
    | "workspaceMode"
    | "runMode"
    | "agentStatus"
    | "clineSessionId"
    | "agentProviderId"
    | "agentModelId"
    | "agentLastEvent"
    | "agentLastError"
    | "agentActivities"
    | "agentFinalResponse"
    | "agentUsage"
    | "agentSessionSummary"
    | "mergedAt"
    | "mergeCommit"
    | "baseCommit"
    | "discardedReason"
  >
> & {
  agentActivity?: UserStoryAgentActivity | null
  agentActivityUpdates?: UserStoryAgentActivity[]
}

export type UserStoryActivityDetail = {
  detail: string
}

export type UserStoryAgentRunDraft = {
  checkpointRunCount?: number | null
  commentId?: string | null
  kind: UserStoryAgentRunKind
  clineSessionId?: string | null
  executionId?: string | null
  status?: UserStoryAgentRunStatus
  providerId?: string | null
  modelId?: string | null
  reasoningEffort?: string | null
}

export type UserStoryAgentRunFinalization = {
  activities: UserStoryAgentActivity[]
  agentLastError?: string | null
  agentLastEvent?: string | null
  completedAt?: string | null
  diffEndRef?: string | null
  finalResponse?: string | null
  outcome: "review" | "paused"
  sessionSummary?: string | null
  status: UserStoryAgentRunTerminalStatus
  usage?: UserStoryAgentUsage | null
  persistenceEvent?: AgentPersistenceEvent
}

export type UserStoryAgentRunUpdate = Partial<
  Pick<
    UserStoryAgentRun,
    | "activities"
    | "checkpointRunCount"
    | "clineSessionId"
    | "completedAt"
    | "diffEndRef"
    | "finalResponse"
    | "sessionSummary"
    | "status"
    | "usage"
  >
> & {
  agentActivity?: UserStoryAgentActivity | null
  agentActivityUpdates?: UserStoryAgentActivity[]
  persistenceEvent?: AgentPersistenceEvent
}

export const backlogColumns = [
  {
    id: "backlog",
    title: "Backlog",
    description: "Draft user stories",
  },
  {
    id: "ready",
    title: "Agent Queue",
    description: "Ready for agents",
  },
  {
    id: "in-progress",
    title: "In Progress",
    description: "Active worktrees",
  },
  {
    id: "in-review",
    title: "In Review",
    description: "Waiting for validation",
  },
  {
    id: "done",
    title: "Done",
    description: "Merged user stories",
  },
  {
    id: "discarded",
    title: "Discarded",
    description: "Rejected or cancelled",
  },
] satisfies { id: BacklogColumnId; title: string; description: string }[]

export function userStoryDisplayId(story: Pick<UserStory, "storyNumber">) {
  return `US-${String(story.storyNumber).padStart(3, "0")}`
}

export function userStoryReadyForAgent(
  story: Pick<
    UserStory,
    "fileAttachments" | "fileAttachmentUploadPending" | "status"
  >
) {
  if (story.status !== "ready") return false
  if (!story.fileAttachmentUploadPending) return true
  return (
    story.fileAttachments?.some(
      (attachment) => attachment.content !== undefined
    ) ?? false
  )
}

export function userStoryActions(story: UserStory): BacklogAction[] {
  if (story.status === "backlog") return ["Discard", "Send to Dev Agent"]
  if (story.status === "ready") return ["Dequeue"]
  if (story.status === "in-progress")
    return story.agentStatus === "Paused"
      ? ["Open Worktree", "Open Preview", "Unpause Agent", "Stop Agent"]
      : ["Open Worktree", "Open Preview", "Stop Agent"]
  if (story.status === "in-review")
    return [
      "Open Worktree",
      "Open Preview",
      "View Diff",
      "View Files",
      "View Terminal",
      "Request Changes",
      "Reject",
      "Approve & Merge",
    ]
  if (story.status === "done") return ["View Diff", "Use Context"]
  return ["Delete Permanently", "Rework"]
}
