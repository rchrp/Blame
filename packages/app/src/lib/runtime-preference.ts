import * as React from "react"
import {
  resolveRuntimePreference,
  type RuntimePreference,
  type RuntimeProfileId,
} from "@blame/preview-runtime"

const storageKey = "blame.runtime-preference.v1"
const activeSessionsKey = "blame.runtime-active-sessions.v1"
const eventName = "blame:runtime-preference"
let cachedRaw: string | null | undefined
let cachedPreference: RuntimePreference = resolveRuntimePreference({})
const defaultRuntimePreference: RuntimePreference = {
  profile: "local-container",
  source: "account-default",
}

// Where stories run. Local Container and Cloud Preview are preview runtime
// profiles; Direct runs the agent in the project folder with no managed
// preview at all.
export type StoryRunMode = RuntimeProfileId | "direct"

type StoredRunPreference = Omit<RuntimePreference, "profile"> & {
  profile: StoryRunMode
}

let cachedRunPreference: StoredRunPreference = resolveRuntimePreference({})

function readRunPreference(): StoredRunPreference {
  const raw = localStorage.getItem(storageKey)
  if (raw === cachedRaw) return cachedRunPreference
  cachedRaw = raw
  try {
    const value = JSON.parse(raw ?? "null") as Partial<StoredRunPreference> | null
    if (
      value &&
      ["local-container", "vercel-compose", "direct"].includes(value.profile ?? "")
    ) {
      cachedRunPreference = {
        profile: value.profile as StoryRunMode,
        source: "account-default",
        ...(value.confirmedCloudUploadAt
          ? { confirmedCloudUploadAt: value.confirmedCloudUploadAt }
          : {}),
      }
      cachedPreference = previewPreference(cachedRunPreference)
      return cachedRunPreference
    }
  } catch {
    cachedRaw = undefined
  }
  if (raw !== null) localStorage.removeItem(storageKey)
  cachedRaw = null
  cachedRunPreference = resolveRuntimePreference({})
  cachedPreference = previewPreference(cachedRunPreference)
  return cachedRunPreference
}

// The preview runtime profile. Direct stories have no managed preview, so
// for preview purposes Direct reads as the local default.
function previewPreference(preference: StoredRunPreference): RuntimePreference {
  return preference.profile === "direct"
    ? { ...preference, profile: "local-container" }
    : (preference as RuntimePreference)
}

export function readRuntimePreference(): RuntimePreference {
  readRunPreference()
  return cachedPreference
}

// Where new stories run by default (the last mode picked).
export function readStoryRunMode(): StoryRunMode {
  return readRunPreference().profile
}

export function hasStoredRunPreference() {
  try {
    return localStorage.getItem(storageKey) !== null
  } catch {
    return false
  }
}

export function saveRuntimePreference(preference: RuntimePreference | StoredRunPreference) {
  localStorage.setItem(storageKey, JSON.stringify(preference))
  cachedRaw = undefined
  window.dispatchEvent(new Event(eventName))
}

export function saveStoryRunMode(mode: StoryRunMode) {
  if (mode === "vercel-compose") {
    saveRuntimePreference({
      profile: mode,
      source: "account-default",
      confirmedCloudUploadAt: new Date().toISOString(),
    })
    return
  }
  // Keep an earlier cloud upload consent: cloud stories already running
  // still rely on it.
  const consent = readRunPreference().confirmedCloudUploadAt
  saveRuntimePreference({
    profile: mode,
    source: "account-default",
    ...(consent ? { confirmedCloudUploadAt: consent } : {}),
  })
}

// Where new stories run. Without Premium, Cloud Preview falls back to the
// local default like the preview profile does.
/** The run mode the person saved, before Premium decides what can run. */
export function useSavedStoryRunMode(): StoryRunMode {
  return React.useSyncExternalStore(
    subscribePreference,
    readRunPreference,
    () => defaultRuntimePreference as StoredRunPreference
  ).profile
}

export function useStoryRunMode(premium: boolean): StoryRunMode {
  const preference = React.useSyncExternalStore(
    subscribePreference,
    readRunPreference,
    () => defaultRuntimePreference as StoredRunPreference
  )
  const preview = useRuntimePreference(premium)
  return preference.profile === "direct" ? "direct" : preview.profile
}

function subscribePreference(callback: () => void) {
  window.addEventListener(eventName, callback)
  window.addEventListener("storage", callback)
  return () => {
    window.removeEventListener(eventName, callback)
    window.removeEventListener("storage", callback)
  }
}

export function recordRuntimeSessionState(
  storyId: string,
  profile: RuntimeProfileId,
  stopped: boolean
) {
  const entries = activeRuntimeSessions()
  if (stopped) {
    delete entries[storyId]
  } else {
    entries[storyId] = { profile, updatedAt: Date.now() }
  }
  saveActiveRuntimeSessions(entries)
}

export function pruneRuntimeSessionStates(activeStoryIds: Set<string>) {
  const entries = activeRuntimeSessions()
  const retained = Object.fromEntries(
    Object.entries(entries).filter(([storyId]) => activeStoryIds.has(storyId))
  )
  saveActiveRuntimeSessions(retained)
}

export function runtimeProfileSwitchBlockReason(profile: RuntimeProfileId) {
  const active = Object.values(activeRuntimeSessions()).find(
    (entry) => entry.profile !== profile
  )
  return active
    ? "Stop the active preview before changing runtime profile."
    : undefined
}

export function runtimePreferenceForPremium(
  preference: RuntimePreference,
  premium: boolean,
  activeCloudPreview = false
): RuntimePreference {
  return preference.profile === "vercel-compose" &&
    !premium &&
    !activeCloudPreview
    ? defaultRuntimePreference
    : preference
}

export function useRuntimePreference(premium: boolean): RuntimePreference {
  const preference = React.useSyncExternalStore(
    (callback) => {
      window.addEventListener(eventName, callback)
      window.addEventListener("storage", callback)
      return () => {
        window.removeEventListener(eventName, callback)
        window.removeEventListener("storage", callback)
      }
    },
    readRuntimePreference,
    () => defaultRuntimePreference
  )
  const activeCloudPreview = React.useSyncExternalStore(
    (callback) => {
      window.addEventListener(eventName, callback)
      window.addEventListener("storage", callback)
      return () => {
        window.removeEventListener(eventName, callback)
        window.removeEventListener("storage", callback)
      }
    },
    () =>
      Object.values(activeRuntimeSessions()).some(
        ({ profile }) => profile === "vercel-compose"
      ),
    () => false
  )
  return runtimePreferenceForPremium(preference, premium, activeCloudPreview)
}

function activeRuntimeSessions() {
  const maximumAgeMs = 24 * 60 * 60_000
  try {
    const value = JSON.parse(
      localStorage.getItem(activeSessionsKey) ?? "{}"
    ) as Record<string, { profile?: unknown; updatedAt?: unknown }>
    const active = Object.fromEntries(
      Object.entries(value).flatMap(([storyId, entry]) =>
        typeof entry.profile === "string" &&
        ["local-container", "vercel-compose"].includes(entry.profile) &&
        typeof entry.updatedAt === "number" &&
        Date.now() - entry.updatedAt <= maximumAgeMs
          ? [
              [
                storyId,
                {
                  profile: entry.profile as RuntimeProfileId,
                  updatedAt: entry.updatedAt,
                },
              ],
            ]
          : []
      )
    )
    if (Object.keys(active).length) {
      localStorage.setItem(activeSessionsKey, JSON.stringify(active))
    } else {
      localStorage.removeItem(activeSessionsKey)
    }
    return active
  } catch {
    localStorage.removeItem(activeSessionsKey)
    return {} as Record<
      string,
      { profile: RuntimeProfileId; updatedAt: number }
    >
  }
}

function saveActiveRuntimeSessions(
  entries: Record<string, { profile: RuntimeProfileId; updatedAt: number }>
) {
  if (Object.keys(entries).length) {
    localStorage.setItem(activeSessionsKey, JSON.stringify(entries))
  } else {
    localStorage.removeItem(activeSessionsKey)
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(eventName))
}
