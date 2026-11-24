import * as React from "react"

import { useCloudAuth } from "@/context/cloud-auth"
import {
  usePlatform,
  type AgentScreenshotData,
  type AgentScreenshotMetadata,
} from "@/context/platform"
import {
  readAgentScreenshot,
  type ScreenshotOwner,
} from "@/lib/agent-screenshot-sync"

import { readEngineImage } from "./engine-image"
import {
  screenshotItemsFromActivities,
  type ScreenshotItem,
} from "./screenshot-items"
export type { ScreenshotItem } from "./screenshot-items"

export type ScreenshotState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { source: string; metadata?: AgentScreenshotMetadata; status: "ready" }

const OwnerContext = React.createContext<ScreenshotOwner | undefined>(undefined)
const GroupContext = React.createContext<ScreenshotItem[]>([])

// The story or chat the conversation belongs to, so a screenshot taken on
// another device can be fetched from the account.
export function AgentScreenshotOwnerProvider({
  children,
  owner,
}: {
  children: React.ReactNode
  owner?: ScreenshotOwner
}) {
  return <OwnerContext.Provider value={owner}>{children}</OwnerContext.Provider>
}

// Every tool screenshot of the conversation, including earlier turns.
export function ScreenshotGroupProvider({
  activities,
  children,
}: {
  activities: Parameters<typeof screenshotItemsFromActivities>[0]
  children: React.ReactNode
}) {
  const items = React.useMemo(
    () => screenshotItemsFromActivities(activities),
    [activities]
  )
  return <GroupContext.Provider value={items}>{children}</GroupContext.Provider>
}

export function useScreenshotGroup() {
  return React.useContext(GroupContext)
}

const maximumCachedScreenshots = 48
const retryUnavailableAfterMs = 30_000
const pending = new Map<string, Promise<void>>()
const loaded = new Map<string, AgentScreenshotData>()
const unavailable = new Map<string, number>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function remember(id: string, data: AgentScreenshotData) {
  loaded.delete(id)
  loaded.set(id, data)
  while (loaded.size > maximumCachedScreenshots) {
    const oldest = loaded.keys().next().value
    if (oldest === undefined) break
    loaded.delete(oldest)
  }
}

function snapshot(
  id: string | undefined
): AgentScreenshotData | "loading" | "unavailable" {
  if (!id) return "unavailable"
  return loaded.get(id) ?? (unavailable.has(id) ? "unavailable" : "loading")
}

// Loads a screenshot once per id: re-renders and other thumbnails reuse
// the cached image. A missing one is tried again after a while, since the
// device that took it may upload it later.
export function useAgentScreenshot(
  item: ScreenshotItem | undefined
): ScreenshotState {
  const platform = usePlatform()
  const auth = useCloudAuth()
  const owner = React.useContext(OwnerContext)
  const id = item?.blob ? undefined : item?.id
  const sessionId = item?.ref?.sessionId
  const blob = useEngineScreenshot(item?.blob ? item.id : undefined)
  const value = React.useSyncExternalStore(subscribe, () => snapshot(id))
  React.useEffect(() => {
    if (!id || loaded.has(id) || pending.has(id)) return
    const failedAt = unavailable.get(id)
    if (
      failedAt !== undefined &&
      Date.now() - failedAt < retryUnavailableAfterMs
    )
      return
    const request = readAgentScreenshot(
      { id, ...(sessionId ? { sessionId } : {}) },
      {
        client: platform.agentScreenshots,
        connection: auth.apiConnection,
        owner,
      }
    )
      .catch(() => null)
      .then((data) => {
        pending.delete(id)
        if (data) {
          unavailable.delete(id)
          remember(id, data)
        } else unavailable.set(id, Date.now())
        listeners.forEach((listener) => listener())
      })
    pending.set(id, request)
  }, [auth.apiConnection, id, owner, platform.agentScreenshots, sessionId])
  if (item?.blob) return blob
  if (value === "loading") return { status: "loading" }
  if (value === "unavailable") return { status: "unavailable" }
  return { source: value.dataUrl, metadata: value.metadata, status: "ready" }
}

function useEngineScreenshot(id: string | undefined): ScreenshotState {
  const { apiConnection } = useCloudAuth()
  const [result, setResult] = React.useState<{
    id: string
    source: string | null
  }>()
  React.useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    let source: string | null = null
    void readEngineImage(apiConnection, id, controller.signal)
      .catch(() => null)
      .then((blob) => {
        if (controller.signal.aborted) return
        source = blob ? URL.createObjectURL(blob) : null
        setResult({ id, source })
      })
    return () => {
      controller.abort()
      if (source) URL.revokeObjectURL(source)
    }
  }, [apiConnection, id])
  if (!id) return { status: "unavailable" }
  if (result?.id !== id) return { status: "loading" }
  return result.source
    ? { status: "ready", source: result.source }
    : { status: "unavailable" }
}
