import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import type { ApiConnection } from "@blame/agent-runtime"

type UploadTarget = {
  expiresAt: string
  headers: Record<string, string>
  url: string
}

type UploadResponse = {
  attachment: UserStoryFileAttachment
  upload: UploadTarget | null
}

// Persist and forward only the attachment contract, including when restoring
// older drafts that may contain fields no longer used by the application.
export function originalFileAttachment(
  attachment: UserStoryFileAttachment
): UserStoryFileAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    ...(attachment.content !== undefined
      ? { content: attachment.content }
      : {}),
    ...(attachment.downloadUrl !== undefined
      ? { downloadUrl: attachment.downloadUrl }
      : {}),
  }
}

export async function uploadFileAttachments(
  connection: ApiConnection,
  attachments: UserStoryFileAttachment[] | null | undefined
) {
  if (!attachments) return attachments
  return Promise.all(
    attachments.map((attachment) =>
      uploadFileAttachment(connection, attachment)
    )
  )
}

export function isFileAttachmentReference(
  value: unknown
): value is UserStoryFileAttachment {
  if (!isRecord(value)) return false
  return (
    typeof value.id === "string" &&
    optionalString(value.content) &&
    optionalString(value.downloadUrl) &&
    typeof value.name === "string" &&
    typeof value.size === "number" &&
    typeof value.type === "string"
  )
}

async function uploadFileAttachment(
  connection: ApiConnection,
  attachment: UserStoryFileAttachment
) {
  if (attachment.content === undefined)
    return originalFileAttachment(attachment)
  const content = decodeBase64(attachment.content)
  const checksumSha256 = await sha256(content)
  const created = await request<UploadResponse>(
    connection,
    "/attachments/uploads",
    {
      body: JSON.stringify({
        checksumSha256,
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        type: attachment.type,
      }),
      method: "POST",
    }
  )
  if (!created.upload) return created.attachment
  try {
    await putAttachment(created.upload, content)
  } catch (error) {
    // A browser cannot distinguish a failed CORS preflight from a network
    // failure. Retry the same, checksum-bound upload through our API once.
    if (
      !(error instanceof TypeError) &&
      !(error instanceof DOMException && error.name === "TimeoutError")
    )
      throw error
    return request<UserStoryFileAttachment>(
      connection,
      `/attachments/${encodeURIComponent(attachment.id)}/content`,
      { method: "POST", body: JSON.stringify({ content: attachment.content }) }
    )
  }
  return request<UserStoryFileAttachment>(
    connection,
    `/attachments/${encodeURIComponent(attachment.id)}/complete`,
    { method: "POST" }
  )
}

async function putAttachment(
  target: UploadTarget,
  content: Uint8Array<ArrayBuffer>
) {
  const response = await fetch(target.url, {
    body: new Blob([content]),
    headers: target.headers,
    method: "PUT",
    credentials: "omit",
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    throw new Error(`Attachment upload failed with status ${response.status}`)
  }
}

async function request<T>(
  connection: ApiConnection,
  path: string,
  init: RequestInit
) {
  const baseUrl = connection.url.replace(/\/$/, "")
  const headers = new Headers(init.headers)
  headers.set("Accept", "application/json")
  headers.set("Content-Type", "application/json")
  if (connection.token)
    headers.set("Authorization", `Bearer ${connection.token}`)
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers })
  if (!response.ok) throw new Error(await responseMessage(response))
  return responseData(await response.json()) as T
}

function decodeBase64(content: string): Uint8Array<ArrayBuffer> {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

async function sha256(content: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", content)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object"
}

function responseData(value: unknown) {
  if (!isRecord(value) || !("data" in value)) return value
  return value.data
}

async function responseMessage(response: Response) {
  try {
    const value = await response.json()
    if (isRecord(value) && typeof value.message === "string")
      return value.message
  } catch {
    return response.statusText
  }
  return response.statusText
}
