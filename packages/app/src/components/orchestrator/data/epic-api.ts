import type {
  Epic,
  EpicDraft,
  EpicUpdate,
} from "@/components/orchestrator/data/epic-data"
import type { useCloudAuth } from "@/context/cloud-auth"

type ApiConnection = ReturnType<typeof useCloudAuth>["apiConnection"]

// The API's `projects/epics` resource. A PATCH replaces `settings` whole.
export function createEpicApi(connection: ApiConnection) {
  const baseUrl = `${connection.url.replace(/\/$/, "")}/projects/epics`
  const call = <T>(path: string, init?: RequestInit) =>
    request<T>(connection, `${baseUrl}${path}`, init)
  return {
    list: (projectId: string) =>
      call<Epic[]>(`?${new URLSearchParams({ projectId })}`),
    create: (input: EpicDraft) =>
      call<Epic>("", { method: "POST", body: JSON.stringify(input) }),
    update: (id: string, input: EpicUpdate) =>
      call<Epic>(`/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    delete: (id: string) => call<void>(`/${id}`, { method: "DELETE" }),
  }
}

export type EpicApi = ReturnType<typeof createEpicApi>

async function request<T>(
  connection: ApiConnection,
  url: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(url, {
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
  return transformerValue(await response.json()) as T
}

async function responseMessage(response: Response) {
  try {
    const payload: unknown = await response.json()
    if (isRecord(payload)) {
      if (typeof payload.message === "string") return payload.message
      const first = Array.isArray(payload.errors) ? payload.errors[0] : null
      if (isRecord(first) && typeof first.message === "string")
        return first.message
    }
  } catch {
    return response.statusText
  }
  return response.statusText
}

function transformerValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(transformerValue)
  if (!isRecord(value)) return value
  if ("data" in value) return transformerValue(value.data)
  // Lucid transformers answer `{ transformerData: [value, …] }`.
  if (Array.isArray(value.transformerData))
    return transformerValue(value.transformerData[0])
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object")
}
