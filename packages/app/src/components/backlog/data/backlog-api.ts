import type {
  UserStory,
  UserStoryDraft,
  UserStoryFileAttachment,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import type { ApiConnection } from "@blame/agent-runtime"
import {
  isFileAttachmentReference,
  uploadFileAttachments,
} from "../../../lib/file-attachment-api.ts"

export function createBacklogApi(connection: ApiConnection) {
  const baseUrl = connection.url.replace(/\/$/, "")

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
            body: JSON.stringify({
              ...input,
              ...(input.agentLastError
                ? { agentLastError: boundedError(input.agentLastError) }
                : {}),
              fileAttachments,
            }),
            method: "PATCH",
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

/** A story as the API sends it (the story service's events carry it so). */
export function parseUserStory(value: unknown) {
  return userStory(value)
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

// The API keeps up to this much of the agent's last error; a provider's
// message can be longer, and the story's state must still be written.
export const agentLastErrorLimit = 4096

function boundedError(text: string) {
  return text.length > agentLastErrorLimit
    ? `${text.slice(0, agentLastErrorLimit - 1)}…`
    : text
}
