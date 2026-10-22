import type { ApiConnection } from "@blame/agent-runtime"
import type {
  AgentScreenshotData,
  AgentScreenshotsClient,
} from "@/context/platform"

// Agent screenshots live on the desktop that took them. Activities only keep
// references, so every referenced screenshot is uploaded with its story or
// chat. Another device fetches it back on demand and caches it locally.

export type ScreenshotOwner = {
  id: string
  kind: "quickChat" | "userStory"
  scope: string
}

export type ScreenshotRefValue = {
  id: string
  sessionId?: string
}

const screenshotIdPattern = /^[0-9a-f]{64}$/u
const uploaded = new Set<string>()
const inFlight = new Map<string, Promise<void>>()

export function screenshotRefsInDetails(
  activities: ReadonlyArray<{ detail?: string }>
) {
  const refs = new Map<string, ScreenshotRefValue>()
  for (const activity of activities) {
    const detail = activity.detail
    if (!detail || !detail.includes("screenshot_ref")) continue
    try {
      collectRefs(JSON.parse(detail), refs)
    } catch {
      // A truncated preview may not parse; its tool call is not a screenshot.
    }
  }
  return [...refs.values()]
}

export async function uploadActivityScreenshots(
  connection: ApiConnection,
  owner: Omit<ScreenshotOwner, "scope">,
  activities: ReadonlyArray<{ detail?: string }> | undefined,
  client: AgentScreenshotsClient | undefined
) {
  if (!client || !activities?.length) return
  const refs = screenshotRefsInDetails(activities)
  await Promise.all(
    refs.map((ref) => uploadOnce(connection, owner, ref, client))
  )
}

function uploadOnce(
  connection: ApiConnection,
  owner: Omit<ScreenshotOwner, "scope">,
  ref: ScreenshotRefValue,
  client: AgentScreenshotsClient
) {
  const key = `${owner.kind}:${owner.id}:${ref.id}`
  if (uploaded.has(key)) return Promise.resolve()
  const current = inFlight.get(key)
  if (current) return current
  const upload = (async () => {
    const local = await client.read({ id: ref.id })
    // Not on this device: it was taken elsewhere and synced from there.
    if (!local) return
    const [, mimeType, data] =
      local.dataUrl.match(/^data:([^;]+);base64,(.+)$/u) ?? []
    if (!mimeType || !data) return
    await screenshotRequest(connection, owner, ref.id, {
      body: JSON.stringify({
        content: data,
        mimeType,
        sessionId: ref.sessionId ?? local.metadata.sessionId ?? null,
      }),
      method: "PUT",
    })
    uploaded.add(key)
  })()
    .catch(() => undefined)
    .finally(() => inFlight.delete(key))
  inFlight.set(key, upload)
  return upload
}

export async function readAgentScreenshot(
  ref: ScreenshotRefValue,
  context: {
    client?: AgentScreenshotsClient
    connection?: ApiConnection
    owner?: ScreenshotOwner
  }
): Promise<AgentScreenshotData | null> {
  if (!screenshotIdPattern.test(ref.id) || !context.client) return null
  const local = await context.client.read({ id: ref.id })
  if (local || !context.connection || !context.owner) return local
  const remote = (await screenshotRequest(
    context.connection,
    context.owner,
    `${ref.id}${ref.sessionId ? `?${new URLSearchParams({ sessionId: ref.sessionId })}` : ""}`,
    { method: "GET" }
  ).catch(() => undefined)) as
    | { content?: unknown; mimeType?: unknown }
    | undefined
  if (
    typeof remote?.content !== "string" ||
    typeof remote.mimeType !== "string"
  )
    return null
  const dataUrl = `data:${remote.mimeType};base64,${remote.content}`
  const metadata = await context.client
    .cache({
      dataUrl,
      id: ref.id,
      metadata: { scope: context.owner.scope, sessionId: ref.sessionId },
    })
    .catch(() => undefined)
  return metadata ? { dataUrl, metadata } : null
}

async function screenshotRequest(
  connection: ApiConnection,
  owner: Omit<ScreenshotOwner, "scope">,
  path: string,
  init: RequestInit
) {
  const base = connection.url.replace(/\/$/, "")
  const collection = owner.kind === "userStory" ? "user-stories" : "quick-chats"
  const headers = new Headers(init.headers)
  headers.set("Accept", "application/json")
  headers.set("Content-Type", "application/json")
  if (connection.token)
    headers.set("Authorization", `Bearer ${connection.token}`)
  const response = await fetch(
    `${base}/projects/${collection}/${encodeURIComponent(owner.id)}/agent-screenshots/${path}`,
    { ...init, headers }
  )
  if (!response.ok)
    throw new Error(`Screenshot request failed (${response.status})`)
  const body = (await response.json()) as Record<string, unknown>
  return body && typeof body.data === "object" ? body.data : body
}

function collectRefs(value: unknown, refs: Map<string, ScreenshotRefValue>) {
  if (Array.isArray(value)) value.forEach((item) => collectRefs(item, refs))
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (
      record.type === "screenshot_ref" &&
      typeof record.id === "string" &&
      screenshotIdPattern.test(record.id)
    ) {
      refs.set(record.id, {
        id: record.id,
        ...(typeof record.sessionId === "string"
          ? { sessionId: record.sessionId }
          : {}),
      })
    } else Object.values(record).forEach((item) => collectRefs(item, refs))
  }
}
