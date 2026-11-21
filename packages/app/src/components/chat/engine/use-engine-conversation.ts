import * as React from "react"
import type { EngineSessionSettings } from "@blame/agent-runtime/engine-protocol"
import { toast } from "sonner"

import type {
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import {
  transcriptConversation,
  type TranscriptConversation,
} from "@/components/chat/engine/transcript-conversation"
import { useEngineSession } from "@/components/chat/engine/use-engine-session"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useLatestCallback } from "@/lib/use-latest-callback"
import { readStoryAttachment } from "@/pages/backlog/story-attachment"
import { storyMessage } from "@/pages/backlog/story-engine"

export type EngineConversationMessage = {
  text: string
  codeSelectionAttachments?: UserStoryCodeSelectionAttachment[]
  fileAttachments?: UserStoryFileAttachment[]
  /** What the agent should know with the message; the conversation does not show it. */
  context?: string
}

const emptyConversation: TranscriptConversation = {
  comments: [],
  queued: [],
  rewindTargets: new Map(),
  runs: [],
}

/**
 * A conversation the app keeps itself (plan mode, the new-project
 * assistant) on an engine session. With a storage key the session id is
 * remembered, so the conversation comes back after a restart; without one
 * it lasts as long as the view. Its turns run in the engine host, whether
 * or not the view is open.
 */
export function useEngineConversation(input: {
  /** Where the session id is remembered; unset keeps it for this view only. */
  storageKey?: string
  /** The settings of the next turn; called only when the conversation is available. */
  settings: () => Promise<EngineSessionSettings> | EngineSessionSettings
  unavailableReason?: string
}) {
  const platform = usePlatform()
  const auth = useCloudAuth()
  const [session, setSession] = React.useState(() =>
    readSession(input.storageKey)
  )
  const [shownKey, setShownKey] = React.useState(input.storageKey)
  if (shownKey !== input.storageKey) {
    setShownKey(input.storageKey)
    setSession(readSession(input.storageKey))
  }
  const view = useEngineSession(session)
  const transcript = view.transcript
  const conversation = React.useMemo(
    () =>
      transcript
        ? transcriptConversation(transcript, "You")
        : emptyConversation,
    [transcript]
  )
  const running =
    transcript?.runningTurn !== undefined ||
    (transcript?.activity.state ?? "idle") !== "idle"

  const deliver = useLatestCallback(
    async (message: EngineConversationMessage) => {
      const engine = platform.engine!
      const settings = await input.settings()
      let target = session
      if (!target) {
        target = crypto.randomUUID()
        await engine.call("createSession", { session: target, ...settings })
        writeSession(input.storageKey, target)
        setSession(target)
      }
      const body = await storyMessage(
        message.text,
        message.codeSelectionAttachments,
        message.fileAttachments,
        (file) => readStoryAttachment(auth.apiConnection, file)
      )
      await engine.call("send", {
        session: target,
        // The context goes with the message for the model only.
        message: message.context ? { ...body, context: message.context } : body,
        delivery: "turn",
        settings,
      })
    }
  )

  /** Starts sending; false when the conversation cannot take a message now. */
  const send = React.useCallback(
    (message: EngineConversationMessage) => {
      if (input.unavailableReason || !platform.engine) return false
      void deliver(message).catch((error: unknown) =>
        toast.error("Unable to send your message", {
          description: error instanceof Error ? error.message : String(error),
          position: "bottom-right",
        })
      )
      return true
    },
    [deliver, input.unavailableReason, platform.engine]
  )

  const stop = useLatestCallback(() => {
    if (session) void platform.engine?.call("interrupt", { session })
  })

  // A new conversation: the old session keeps its records, unnamed.
  const reset = useLatestCallback(() => {
    if (session) void platform.engine?.call("interrupt", { session })
    writeSession(input.storageKey, undefined)
    setSession(undefined)
  })

  return {
    conversation,
    error: view.error,
    running,
    reset,
    send,
    session,
    stop,
  }
}

function readSession(key: string | undefined) {
  if (!key) return undefined
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function writeSession(key: string | undefined, session: string | undefined) {
  if (!key) return
  try {
    if (session) localStorage.setItem(key, session)
    else localStorage.removeItem(key)
  } catch {
    // The conversation lasts for this view only.
  }
}
