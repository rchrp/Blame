import * as React from "react"

import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform, type AgentScreenshotData } from "@/context/platform"
import {
  readAgentScreenshot,
  type ScreenshotOwner,
} from "@/lib/agent-screenshot-sync"

import { screenshotRefs } from "../tool-calls/describe-preview-devtools"
import type { ScreenshotRef } from "../tool-calls/tool-call-view"

// A screenshot as shown in the conversation: its id, what the tool result
// said about it when known, and a caption chosen by the agent.
export type ScreenshotItem = {
  caption?: string
  id: string
  ref?: ScreenshotRef
}

export type ScreenshotState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { data: AgentScreenshotData; status: "ready" }

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

// Every screenshot of one turn, so the lightbox can move between them.
export function ScreenshotGroupProvider({
  activities,
  children,
}: {
  activities: ReadonlyArray<{ detail: string; kind: string }>
  children: React.ReactNode
}) {
  // Compared by content: activity objects are recreated on every update.
  const key = activities
    .filter(
      (activity) =>
        activity.kind === "tool" && activity.detail.includes("screenshot_ref")
    )
    .map((activity) => activity.detail)
    .join("\u0000")
  const items = React.useMemo(
    () => screenshotItemsFromDetails(key ? key.split("\u0000") : []),
    [key]
  )
  return <GroupContext.Provider value={items}>{children}</GroupContext.Provider>
}

export function useScreenshotGroup() {
  return React.useContext(GroupContext)
}

export function screenshotItemsFromDetails(details: string[]) {
  const refs: ScreenshotRef[] = []
  for (const detail of details) {
    try {
      screenshotRefs(JSON.parse(detail), refs)
    } catch {
      // A truncated preview: no screenshot to show from it.
    }
  }
  return refs.map((ref) => ({ id: ref.id, ref }))
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
  const id = item?.id
  const sessionId = item?.ref?.sessionId
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
  if (value === "loading") return { status: "loading" }
  if (value === "unavailable") return { status: "unavailable" }
  return { data: value, status: "ready" }
}
