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
  | "Approve, Merge & Push"
  | "Open PR"
  | "Use Context"
  | "Rework"
  | "Delete Permanently"

export type UserStoryPriority = "Low" | "Medium" | "High"
export type UserStoryAgentStatus = "Running" | "Paused"
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
  // "user": a message the person sent into the running turn (a steer);
  // `title` is its author, `detail` its text.
  kind:
    | "reasoning"
    | "message"
    | "tool"
    | "approval"
    | "notice"
    | "error"
    | "user"
  title: string
  detail: string
  status?: "running" | "completed" | "failed"
  iteration?: number
  messageKind?: "intermediate" | "final"
  toolCallId?: string
  toolName?: string
  detailArtifact?: string
  detailTruncated?: boolean
  originalDetailLength?: number
  // Screenshots the agent chose to show above its final reply.
  images?: Array<{ caption: string; id: string }>
  // The files of a steered message ("user").
  fileAttachments?: UserStoryFileAttachment[]
  // An error the person fixes by choosing another model (a used-up plan).
  action?: "choose-model"
  createdAt: string
  updatedAt?: string
}

export type UserStoryCodeSelectionAttachment = {
  id: string
  content: string
  endLine: number
  // Where the excerpt was selected: a source file unless it says otherwise.
  // A story attached as context keeps its number in path, its title in
  // content and its id in storyId.
  origin?: "code" | "message" | "story"
  path: string
  startLine: number
  storyId?: string
}

export type UserStoryFileAttachment = {
  id: string
  // A file the engine keeps (a sent message's): its blob, by sha256.
  blobId?: string
  content?: string
  downloadUrl?: string
  name: string
  size: number
  type: string
}

export type UserStoryAgentModel = {
  providerId: string
  modelId: string
  reasoningEffort?: string | null
  /** Turns this model answered, from the story's engine records. */
  turns?: number
}

export type UserStoryAgentRunKind = "initial" | "change-request" | "resume"
export type UserStoryAgentRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
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
  // The branch the story starts from and merges into. Null until chosen in
  // the composer or recorded at the first run: the project folder's branch.
  targetBranch?: string | null
  // The GitHub pull request opened from the story with Open PR.
  pullRequestUrl?: string | null
  previewUrl?: string | null
  runConfigurationId?: string | null
  worktree?: string | null
  workspaceMode?: "local-container" | "cloud-mirror" | "direct" | null
  // Where the person chose to run it (kept across requeues). Null on
  // stories made before the choice was per story: the account default.
  runMode?: "local-container" | "vercel-compose" | "direct" | null
  // How far the agent goes on this story, as chosen from the composer menu.
  // Null follows the ambition set in Settings.
  ambition?: "quick" | "standard" | "ambitious" | null
  // Running while its agent works, Paused when it stopped mid-work. Written
  // by the story service in the engine host when a turn starts or ends.
  agentStatus?: UserStoryAgentStatus | null
  // Why the agent could not start, shown on the queued card.
  agentLastError?: string | null
  // The engine session holding the story's conversation with its agent.
  engineSessionId?: string | null
  // The models that worked on the story, for the card's avatars.
  agentModels?: UserStoryAgentModel[] | null
  // Stories of the project this one starts after, once each is done.
  startsAfter?: string[] | null
  // The model its first run uses instead of the account's.
  requestedModel?: {
    providerId: string
    modelId: string
    credentialLabel?: string
    reasoningEffort?: string
  } | null
  // What the orchestrator wanted of that model when it chose it.
  modelIntent?: "cheaper" | "balanced" | "smarter" | null
  // The epic the orchestrator made the story for (docs/orchestrator.md).
  epicId?: string | null
  mergedAt?: string | null
  mergeCommit?: string | null
  baseCommit?: string | null
  discardedReason?: string | null
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
  targetBranch?: UserStory["targetBranch"]
  ambition?: UserStory["ambition"]
  startsAfter?: UserStory["startsAfter"]
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
    | "targetBranch"
    | "pullRequestUrl"
    | "previewUrl"
    | "runConfigurationId"
    | "worktree"
    | "workspaceMode"
    | "runMode"
    | "ambition"
    | "startsAfter"
    | "agentStatus"
    | "agentLastError"
    | "engineSessionId"
    | "agentModels"
    | "mergedAt"
    | "mergeCommit"
    | "baseCommit"
    | "discardedReason"
  >
>

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

// The stories a story starts after, as its field lists them: each with the
// story it names, or none when that story is gone.
export type StartsAfterEntry = {
  id: string
  story?: Pick<UserStory, "id" | "status" | "storyNumber" | "title">
}

export function startsAfterEntries(
  ids: readonly string[] | null | undefined,
  stories: readonly Pick<UserStory, "id" | "status" | "storyNumber" | "title">[]
): StartsAfterEntry[] {
  const byId = new Map(stories.map((story) => [story.id, story]))
  return [...new Set(ids ?? [])].map((id) => ({ id, story: byId.get(id) }))
}

// The stories the person may pick: the project's own, newest first, never
// the story itself and never one that was discarded (it would not be done).
export function startsAfterChoices<
  Story extends Pick<UserStory, "id" | "status" | "storyNumber">,
>(stories: readonly Story[], storyId: string | undefined) {
  return stories
    .filter((story) => story.id !== storyId && story.status !== "discarded")
    .sort((left, right) => right.storyNumber - left.storyNumber)
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
