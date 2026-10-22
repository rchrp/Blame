import type {
  QuickChat,
  QuickChatActivityDetail,
  QuickChatAgentRun,
  QuickChatAgentRunDraft,
  QuickChatAgentRunFinalization,
  QuickChatAgentRunUpdate,
  QuickChatDraft,
  QuickChatMessage,
  QuickChatMessageDraft,
  QuickChatUpdate,
} from "@/components/chat/data/quick-chat-data"
import type { useCloudAuth } from "@/context/cloud-auth"
import type { AgentScreenshotsClient } from "@/context/platform"
import type { UserStoryAgentActivity } from "@/components/backlog/data/backlog-data"
import { uploadActivityScreenshots } from "@/lib/agent-screenshot-sync"
import {
  isFileAttachmentReference,
  uploadFileAttachments,
} from "@/lib/file-attachment-api"

type ApiConnection = ReturnType<typeof useCloudAuth>["apiConnection"]

export function createQuickChatApi(
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
      { id, kind: "quickChat" },
      payloadActivities(input),
      screenshots
    )

  return {
    async list(projectId: string) {
      return quickChatList(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/quick-chats?${new URLSearchParams({
            projectId,
            view: "summary",
          })}`
        ),
        { detail: false }
      )
    },
    async get(id: string) {
      return quickChat(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/quick-chats/${id}`
        )
      )
    },
    async create(input: QuickChatDraft) {
      return quickChat(
        await request<unknown>(connection, baseUrl, "/projects/quick-chats", {
          body: JSON.stringify(input),
          method: "POST",
        })
      )
    },
    async update(id: string, input: QuickChatUpdate) {
      syncScreenshots(id, input)
      return quickChat(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/quick-chats/${id}`,
          {
            body: JSON.stringify(apiUpdate(input)),
            method: "PATCH",
          }
        )
      )
    },
    async undoMessage(
      id: string,
      messageId: string,
      input: { clineSessionId?: string; runId: string }
    ) {
      return quickChat(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/quick-chats/${id}/messages/${messageId}/undo`,
          {
            body: input ? JSON.stringify(input) : undefined,
            method: "POST",
          }
        )
      )
    },
    async validateMessageUndo(id: string, messageId: string, runId: string) {
      await request<unknown>(
        connection,
        baseUrl,
        `/projects/quick-chats/${id}/messages/${messageId}/undo-validation`,
        { body: JSON.stringify({ runId }), method: "POST" }
      )
    },
    async createMessage(id: string, input: QuickChatMessageDraft) {
      const fileAttachments = await uploadFileAttachments(
        connection,
        input.fileAttachments
      )
      return quickChatMessage(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/quick-chats/${id}/messages`,
          {
            body: JSON.stringify({ ...input, fileAttachments }),
            method: "POST",
          }
        )
      )
    },
    async createAgentRun(id: string, input: QuickChatAgentRunDraft) {
      return quickChatAgentRun(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/quick-chats/${id}/agent-runs`,
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
      input: QuickChatAgentRunUpdate
    ) {
      syncScreenshots(id, input)
      return quickChatAgentRun(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/quick-chats/${id}/agent-runs/${runId}`,
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
      input: QuickChatAgentRunFinalization
    ) {
      syncScreenshots(id, input)
      return quickChat(
        await request<unknown>(
          connection,
          baseUrl,
          `/projects/quick-chats/${id}/agent-runs/${runId}/finalize`,
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
          `/projects/quick-chats/${id}/agent-runs/${runId}/activities/${encodeURIComponent(activityId)}`
        )
      )
    },
    async delete(id: string) {
      await request<void>(connection, baseUrl, `/projects/quick-chats/${id}`, {
        method: "DELETE",
      })
    },
  }
}

function apiUpdate(input: QuickChatUpdate) {
  if (!input.agentActivity && !input.agentActivityUpdates) return input
  const { agentActivities, ...update } = input
  void agentActivities
  return update
}

function apiAgentRunUpdate(input: QuickChatAgentRunUpdate) {
  if (!input.agentActivity && !input.agentActivityUpdates) return input
  const { activities, ...update } = input
  void activities
  return update
}

function activityDetail(value: unknown) {
  if (!isRecord(value)) throw new Error("Unable to read agent activity detail.")
  if (typeof value.detail !== "string")
    throw new Error("Unable to read agent activity detail.")
  return value as QuickChatActivityDetail
}

function quickChatList(value: unknown, options: QuickChatOptions = {}) {
  if (Array.isArray(value)) return value.map((item) => quickChat(item, options))
  if (!isRecord(value)) throw new Error("Unable to read quick chats.")
  if ("data" in value) return quickChatList(value.data, options)
  throw new Error("Unable to read quick chats.")
}

type QuickChatOptions = {
  detail?: boolean
}

function quickChat(value: unknown, options: QuickChatOptions = {}) {
  const chat = transformerValue(value)
  const id = stringId(recordValue(chat).id)
  if (!isRecord(chat)) throw new Error("Unable to read quick chat.")
  if (id === undefined) throw new Error("Unable to read quick chat.")
  if (typeof chat.projectId !== "string")
    throw new Error("Unable to read quick chat.")
  if (typeof chat.title !== "string")
    throw new Error("Unable to read quick chat.")
  const output = {
    ...chat,
    id,
  } as QuickChat
  if (Array.isArray(chat.agentRuns)) {
    output.agentRuns = chat.agentRuns.map(quickChatAgentRun)
  } else if (options.detail !== false) {
    output.agentRuns = []
  }
  if (Array.isArray(chat.messages)) {
    output.messages = chat.messages.map(quickChatMessage)
  } else if (options.detail !== false) {
    output.messages = []
  }
  return output
}

function quickChatMessage(value: unknown) {
  const message = transformerValue(value)
  const id = stringId(recordValue(message).id)
  const quickChatId = stringId(recordValue(message).quickChatId)
  if (!isRecord(message)) throw new Error("Unable to read quick chat message.")
  if (id === undefined || quickChatId === undefined)
    throw new Error("Unable to read quick chat message.")
  if (typeof message.body !== "string")
    throw new Error("Unable to read quick chat message.")
  return {
    ...message,
    author: typeof message.author === "string" ? message.author : "You",
    createdAt:
      typeof message.createdAt === "string"
        ? message.createdAt
        : new Date().toISOString(),
    id,
    fileAttachments: Array.isArray(message.fileAttachments)
      ? message.fileAttachments.filter(isFileAttachmentReference)
      : [],
    quickChatId,
  } as QuickChatMessage
}

function quickChatAgentRun(value: unknown) {
  const run = transformerValue(value)
  const id = stringId(recordValue(run).id)
  const quickChatId = stringId(recordValue(run).quickChatId)
  if (!isRecord(run)) throw new Error("Unable to read quick chat agent run.")
  if (id === undefined || quickChatId === undefined)
    throw new Error("Unable to read quick chat agent run.")
  if (typeof run.kind !== "string")
    throw new Error("Unable to read quick chat agent run.")
  if (typeof run.status !== "string")
    throw new Error("Unable to read quick chat agent run.")
  return {
    ...run,
    id,
    messageId: stringId(recordValue(run).messageId) ?? null,
    quickChatId,
  } as QuickChatAgentRun
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
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  })
  if (!response.ok) throw new Error(await responseMessage(response))
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function responseMessage(response: Response) {
  try {
    const payload = await response.json()
    if (isRecord(payload) && typeof payload.message === "string")
      return payload.message
  } catch {
    return response.statusText
  }
  return response.statusText
}

function stringId(value: unknown) {
  if (typeof value !== "string") return undefined
  return value.trim() ? value : undefined
}

function recordValue(value: unknown) {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object")
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
