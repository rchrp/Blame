import type {
  UserStory,
  UserStoryAgentActivity,
  UserStoryActivityDetail,
  UserStoryAgentRun,
  UserStoryAgentRunDraft,
  UserStoryAgentRunFinalization,
  UserStoryAgentRunUpdate,
  UserStoryComment,
  UserStoryDraft,
  UserStoryFileAttachment,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import type { ApiConnection } from "@blame/agent-runtime"
import type { AgentScreenshotsClient } from "@/context/platform"
import { uploadActivityScreenshots } from "../../../lib/agent-screenshot-sync.ts"
import { boundedAgentUpdate } from "./agent-update-limits.ts"
import {
  isFileAttachmentReference,
  uploadFileAttachments,
} from "../../../lib/file-attachment-api.ts"

export function createBacklogApi(
  connection: ApiConnection,
  screenshots?: AgentScreenshotsClient
) {
  const baseUrl = connection.url.replace(/\/$/, "")
  const syncScreenshots = (
    id: string,
    input: Parameters<typeof payloadActivities>[0]
  ) =>
    void uploadActivityScreenshots(
      connection,
      { id, kind: "userStory" },
      payloadActivities(input),
      screenshots
    )

  return {
    async list(projectId: string) {
      return userStoryList(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/user-stories?${new URLSearchParams({
            projectId,
            view: "summary",
          })}`
        ),
        { detail: false }
      )
    },
    async get(id: string) {
      return userStory(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/user-stories/${id}`
        )
      )
    },
    async create(input: UserStoryDraft) {
      return createUserStory(connection, baseUrl, input)
    },
    async update(id: string, input: UserStoryUpdate) {
      syncScreenshots(id, input)
      const fileAttachments =
        input.fileAttachments === undefined
          ? undefined
          : await uploadFileAttachments(connection, input.fileAttachments)
      return userStory(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/user-stories/${id}`,
          {
            body: JSON.stringify(apiUpdate({ ...input, fileAttachments })),
            method: "PATCH",
          }
        )
      )
    },
    async undoComment(
      id: string,
      commentId: string,
      input: { clineSessionId?: string; runId: string }
    ) {
      return userStory(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/user-stories/${id}/comments/${commentId}/undo`,
          {
            body: input ? JSON.stringify(input) : undefined,
            method: "POST",
          }
        )
      )
    },
    async validateCommentUndo(id: string, commentId: string, runId: string) {
      await request<unknown>(
        connection,
        baseUrl,
        `/projects/user-stories/${id}/comments/${commentId}/undo-validation`,
        { body: JSON.stringify({ runId }), method: "POST" }
      )
    },
    async activityDetail(id: string, activityId: string) {
      return activityDetail(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/user-stories/${id}/agent-activities/${encodeURIComponent(activityId)}`
        )
      )
    },
    async createAgentRun(id: string, input: UserStoryAgentRunDraft) {
      return userStoryAgentRun(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/user-stories/${id}/agent-runs`,
          {
            body: JSON.stringify(input),
            method: "POST",
          }
        )
      )
    },
    async updateAgentRun(
      id: string,
      runId: string,
      input: UserStoryAgentRunUpdate
    ) {
      syncScreenshots(id, input)
      return userStoryAgentRun(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/user-stories/${id}/agent-runs/${runId}`,
          {
            body: JSON.stringify(apiAgentRunUpdate(input)),
            method: "PATCH",
          }
        )
      )
    },
    async finalizeAgentRun(
      id: string,
      runId: string,
      input: UserStoryAgentRunFinalization
    ) {
      syncScreenshots(id, input)
      return userStory(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/user-stories/${id}/agent-runs/${runId}/finalize`,
          {
            body: JSON.stringify(input),
            method: "POST",
          }
        )
      )
    },
    async agentRunActivityDetail(
      id: string,
      runId: string,
      activityId: string
    ) {
      return activityDetail(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/user-stories/${id}/agent-runs/${runId}/activities/${encodeURIComponent(activityId)}`
        )
      )
    },
    async createComment(
      id: string,
      input: Pick<
        UserStoryComment,
        "body" | "codeSelectionAttachments" | "fileAttachments"
      >
    ) {
      const fileAttachments = await uploadFileAttachments(
        connection,
        input.fileAttachments
      )
      return userStoryComment(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/user-stories/${id}/comments`,
          {
            body: JSON.stringify({ ...input, fileAttachments }),
            method: "POST",
          }
        )
      )
    },
    async delete(id: string) {
      await request<void>(connection, baseUrl, `/projects/user-stories/${id}`, {
        method: "DELETE",
      })
    },
  }
}

export class BacklogApiError extends Error {
  readonly retryable: boolean
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "BacklogApiError"
    this.retryable = status === 408 || status === 429 || status >= 500
    this.status = status
  }
}

export function retryableBacklogError(error: unknown) {
  return !(error instanceof BacklogApiError) || error.retryable
}

async function createUserStory(
  connection: ApiConnection,
  baseUrl: string,
  input: UserStoryDraft
) {
  const uploadsPending = input.fileAttachments?.some(hasInlineContent) ?? false
  const story = await createInitialUserStory(
    connection,
    baseUrl,
    input,
    uploadsPending
  )
  if (!uploadsPending) return { story }
  return pendingAttachmentCreation(connection, baseUrl, input, story)
}

function pendingAttachmentCreation(
  connection: ApiConnection,
  baseUrl: string,
  input: UserStoryDraft,
  story: UserStory
) {
  return {
    completeAttachmentUpload: () =>
      defer(() =>
        completeCreatedStoryUpload(connection, baseUrl, story.id, input)
      ),
    story: {
      ...story,
      fileAttachments: input.fileAttachments,
      fileAttachmentUploadStatus: "uploading" as const,
    },
  }
}

async function createInitialUserStory(
  connection: ApiConnection,
  baseUrl: string,
  input: UserStoryDraft,
  uploadsPending: boolean
) {
  return userStory(
    await request<unknown>(connection, baseUrl, "/projects/user-stories", {
      body: JSON.stringify({
        ...input,
        fileAttachments: storedFileAttachments(input.fileAttachments),
        fileAttachmentUploadPending: uploadsPending,
      }),
      method: "POST",
    })
  )
}

async function completeCreatedStoryUpload(
  connection: ApiConnection,
  baseUrl: string,
  storyId: string,
  input: UserStoryDraft
) {
  const fileAttachments = await uploadFileAttachments(
    connection,
    input.fileAttachments
  )
  return userStory(
    await request<unknown>(
      connection,
      baseUrl,
      `/projects/user-stories/${storyId}`,
      {
        body: JSON.stringify({
          fileAttachments,
          fileAttachmentUploadPending: false,
        }),
        method: "PATCH",
      }
    )
  )
}

function storedFileAttachments(attachments: UserStoryDraft["fileAttachments"]) {
  return attachments?.filter((attachment) => !hasInlineContent(attachment))
}

function hasInlineContent(attachment: UserStoryFileAttachment) {
  return attachment.content !== undefined
}

function defer<T>(task: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => void task().then(resolve, reject), 0)
  })
}

function apiUpdate(input: UserStoryUpdate) {
  const boundedInput = boundedAgentUpdate(input)
  if (!boundedInput.agentActivity && !boundedInput.agentActivityUpdates)
    return boundedInput
  const { agentActivities, ...update } = boundedInput
  void agentActivities
  return update
}

function apiAgentRunUpdate(input: UserStoryAgentRunUpdate) {
  if (!input.agentActivity && !input.agentActivityUpdates) return input
  const { activities, ...update } = input
  void activities
  return update
}

function activityDetail(value: unknown) {
  if (!isRecord(value)) throw new Error("Unable to read agent activity detail.")
  if (typeof value.detail !== "string")
    throw new Error("Unable to read agent activity detail.")
  return value as UserStoryActivityDetail
}

function userStoryAgentRun(value: unknown) {
  const run = transformerValue(value)
  const id = stringId(recordValue(run).id)
  const userStoryId = stringId(recordValue(run).userStoryId)
  if (!isRecord(run)) throw new Error("Unable to read user story agent run.")
  if (id === undefined || userStoryId === undefined)
    throw new Error("Unable to read user story agent run.")
  if (typeof run.kind !== "string")
    throw new Error("Unable to read user story agent run.")
  if (typeof run.status !== "string")
    throw new Error("Unable to read user story agent run.")
  return {
    ...run,
    commentId: stringId(recordValue(run).commentId) ?? null,
    id,
    userStoryId,
  } as UserStoryAgentRun
}

function userStoryComment(value: unknown) {
  const comment = transformerValue(value)
  const id = stringId(recordValue(comment).id)
  const userStoryId = stringId(recordValue(comment).userStoryId)
  if (!isRecord(comment)) throw new Error("Unable to read user story comment.")
  if (id === undefined) throw new Error("Unable to read user story comment.")
  if (typeof comment.body !== "string")
    throw new Error("Unable to read user story comment.")
  return {
    author: typeof comment.author === "string" ? comment.author : "Product",
    body: comment.body,
    codeSelectionAttachments: codeSelectionAttachments(
      recordValue(comment).codeSelectionAttachments
    ),
    fileAttachments: fileAttachments(recordValue(comment).fileAttachments),
    createdAt:
      typeof comment.createdAt === "string"
        ? comment.createdAt
        : new Date().toISOString(),
    id,
    updatedAt: typeof comment.updatedAt === "string" ? comment.updatedAt : null,
    userStoryId: userStoryId ?? "",
  } satisfies UserStoryComment
}

function userStoryList(value: unknown, options: UserStoryOptions = {}) {
  if (Array.isArray(value)) return value.map((item) => userStory(item, options))
  if (!isRecord(value)) throw new Error("Unable to read user stories.")
  if ("data" in value) return userStoryList(value.data, options)
  throw new Error("Unable to read user stories.")
}

type UserStoryOptions = {
  detail?: boolean
}

function userStory(value: unknown, options: UserStoryOptions = {}) {
  const story = transformerValue(value)
  const id = stringId(recordValue(story).id)
  if (!isRecord(story)) throw new Error("Unable to read user story.")
  if (id === undefined) throw new Error("Unable to read user story.")
  if (typeof story.storyNumber !== "number")
    throw new Error("Unable to read user story.")
  if (typeof story.projectId !== "string")
    throw new Error("Unable to read user story.")
  if (typeof story.title !== "string")
    throw new Error("Unable to read user story.")
  const output = {
    ...story,
    id,
    storyNumber: story.storyNumber,
  } as UserStory
  if (options.detail !== false || "codeSelectionAttachments" in story) {
    output.codeSelectionAttachments = codeSelectionAttachments(
      recordValue(story).codeSelectionAttachments
    )
  }
  if (options.detail !== false || "fileAttachments" in story) {
    output.fileAttachments = fileAttachments(recordValue(story).fileAttachments)
  }
  if (Array.isArray(story.agentRuns)) {
    output.agentRuns = story.agentRuns.map(userStoryAgentRun)
  } else if (options.detail !== false) {
    output.agentRuns = []
  }
  if (Array.isArray(story.runningAgentRuns)) {
    output.runningAgentRuns = story.runningAgentRuns.map(userStoryAgentRun)
  }
  if (Array.isArray(story.comments)) {
    output.comments = story.comments.map(userStoryComment)
  } else if (options.detail !== false) {
    output.comments = []
  }
  return output
}

function codeSelectionAttachments(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter(codeSelectionAttachment)
}

function codeSelectionAttachment(value: unknown) {
  if (!isRecord(value)) return false
  return (
    typeof value.id === "string" &&
    typeof value.content === "string" &&
    typeof value.endLine === "number" &&
    typeof value.path === "string" &&
    typeof value.startLine === "number"
  )
}

function fileAttachments(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter(fileAttachment)
}

function fileAttachment(value: unknown) {
  return isFileAttachmentReference(value)
}

function transformerValue(value: unknown): unknown {
  if (!isRecord(value)) return value
  if ("data" in value) return transformerValue(value.data)
  if (!Array.isArray(value.transformerData)) return value
  return transformerValue(value.transformerData[0])
}

async function request<T>(
  connection: ApiConnection,
  baseUrl: string,
  path: string,
  init?: RequestInit
) {
  const headers = new Headers(init?.headers)
  headers.set("Accept", "application/json")
  headers.set("Content-Type", "application/json")
  if (connection.token)
    headers.set("Authorization", `Bearer ${connection.token}`)

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  })

  if (!response.ok)
    throw new BacklogApiError(response.status, await responseMessage(response))
  if (response.status === 204) return undefined as T
  return unwrapResponse<T>(await response.json())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function recordValue(value: unknown) {
  return isRecord(value) ? value : {}
}

function stringId(value: unknown) {
  if (typeof value !== "string") return undefined
  return value.trim() ? value : undefined
}

function unwrapResponse<T>(value: unknown) {
  if (isRecord(value) && "data" in value) return value.data as T
  return value as T
}

async function responseMessage(response: Response) {
  try {
    const body = await response.json()
    if (typeof body.message === "string") return body.message
    if (Array.isArray(body.errors)) {
      const error = body.errors.find(
        (value: unknown) => isRecord(value) && typeof value.message === "string"
      )
      if (isRecord(error) && typeof error.message === "string")
        return error.message
    }
  } catch {
    return `Request failed with status ${response.status}`
  }
  return `Request failed with status ${response.status}`
}

// Activities sent to the account: any screenshot they reference is
// uploaded alongside, in the background.
function payloadActivities(input: {
  activities?: UserStoryAgentActivity[] | null
  agentActivities?: UserStoryAgentActivity[] | null
  agentActivity?: UserStoryAgentActivity | null
  agentActivityUpdates?: UserStoryAgentActivity[]
}) {
  return [
    ...(input.activities ?? []),
    ...(input.agentActivities ?? []),
    ...(input.agentActivity ? [input.agentActivity] : []),
    ...(input.agentActivityUpdates ?? []),
  ]
}
