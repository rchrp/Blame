import * as React from "react"
import type { EngineSessionSettings } from "@blame/agent-runtime/engine-protocol"
import { toast } from "sonner"

import { storyMaxInputTokens } from "@/components/backlog/data/story-context-limit"
import { engineModelChoice } from "@/components/chat/engine/engine-model"
import type { EngineConversationMessage } from "@/components/chat/engine/use-engine-conversation"
import { transcriptConversation } from "@/components/chat/engine/transcript-conversation"
import {
  modelForPreference,
  useModelSelection,
} from "@/components/model/model-selection"
import type { Epic } from "@/components/orchestrator/data/epic-data"
import {
  useEpicSession,
  useEpicStore,
} from "@/components/orchestrator/data/epic-store"
import { epicTranscript } from "@/components/orchestrator/data/epic-transcript"
import { orchestratorPreference } from "@/components/orchestrator/data/use-epic-models"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { conversationPersonalization } from "@/lib/agent-personalization"
import { epicAmbitionKey } from "@/lib/conversation-ambition"
import { readStoryAttachment } from "@/pages/backlog/story-attachment"
import { storyMessage } from "@/pages/backlog/story-engine"

// The epic's conversation with its orchestrator: the engine session named in
// `epic.engineSessionId` (docs/orchestrator.md, "What the screen reads").
// The first message creates it (the host then makes the epic's branch and
// writes the session to the epic); each message goes with the purpose's
// settings. The host's state of the epic (`epicState`, the `epic` event)
// comes from the epic store.

/** Sending to an epic's orchestrator, its session created on the first message. */
export function useEpicMessenger() {
  const platform = usePlatform()
  const auth = useCloudAuth()
  const project = useProjects().activeProject
  const epics = useEpicStore()
  const selection = useModelSelection({ role: "agent" })

  const unavailable = (epic: Epic) =>
    !platform.engine
      ? "The orchestrator runs in the Blame desktop app."
      : !project?.path
        ? "Open the project on this computer to talk to its orchestrator."
        : auth.status !== "authenticated"
          ? "Sign in to talk to the orchestrator."
          : !epic.settings.orchestratorModel && !selection.currentModel
            ? "Choose a model in the epic's settings."
            : undefined

  const settingsFor = (epic: Epic): EngineSessionSettings => {
    const ambitionKey = epicAmbitionKey(epic.id)
    const chosen = modelForPreference(
      selection.models,
      orchestratorPreference(epic.settings.orchestratorModel)
    )
    const shown = chosen?.model ?? selection.currentModel
    return {
      purpose: "orchestrator",
      settings: {
        workspace: { root: project!.path!, location: "host" },
        projectId: epic.projectId,
        epicId: epic.id,
        // The epic's own model wins in the host; the window's is the fallback.
        model: epic.settings.orchestratorModel ?? engineModelChoice(selection),
        ...(shown
          ? {
              maxContextTokens: storyMaxInputTokens(
                ambitionKey,
                shown,
                selection.allProviders
              ),
            }
          : {}),
        personalization: conversationPersonalization(ambitionKey),
      },
    }
  }

  const deliver = async (epic: Epic, message: EngineConversationMessage) => {
    const engine = platform.engine!
    const settings = settingsFor(epic)
    let session = epic.engineSessionId
    if (!session) {
      session = crypto.randomUUID()
      await engine.call("createSession", { session, ...settings })
      // The host wrote the session and the epic's branch to the epic.
      await epics.reload(epic.id).catch(() => undefined)
    }
    const body = await storyMessage(
      message.text,
      message.codeSelectionAttachments,
      message.fileAttachments,
      (file) => readStoryAttachment(auth.apiConnection, file)
    )
    await engine.call("send", {
      session,
      message: message.context ? { ...body, context: message.context } : body,
      delivery: "turn",
      settings,
    })
    return session
  }

  return { deliver, unavailable }
}

export function useEpicConversation(epic: Epic) {
  const platform = usePlatform()
  const epics = useEpicStore()
  const messenger = useEpicMessenger()
  const session = epic.engineSessionId ?? undefined
  const view = useEpicSession()
  const transcript = view.transcript
  const conversation = React.useMemo(
    () => transcript && transcriptConversation(transcript, "You"),
    [transcript]
  )
  const entries = React.useMemo(
    () => (transcript ? epicTranscript(transcript) : []),
    [transcript]
  )
  const state = epics.states.get(epic.id)
  const running =
    transcript?.runningTurn !== undefined ||
    (transcript?.activity.state ?? "idle") !== "idle"
  const unavailableReason = messenger.unavailable(epic)

  const send = async (message: EngineConversationMessage) => {
    if (unavailableReason) return false
    try {
      await messenger.deliver(epic, message)
      return true
    } catch (error) {
      toast.error("Unable to send your message", {
        description: error instanceof Error ? error.message : String(error),
        position: "bottom-right",
      })
      return false
    }
  }

  const stop = () => {
    if (session) void platform.engine?.call("interrupt", { session })
  }

  return {
    conversation,
    queue: {
      remove: async (turn: string) => {
        await platform.engine!.call("withdraw", { session: session!, turn })
      },
      sendNow: async (turn: string) => {
        await platform.engine!.call("promote", { session: session!, turn })
      },
      edit: async (turn: string, text: string) => {
        await platform.engine!.call("withdraw", { session: session!, turn })
        await messenger.deliver(epic, { text })
      },
    },
    transcript,
    error: view.error,
    entries,
    loaded: !session || view.loaded,
    running,
    session,
    state,
    send,
    stop,
    unavailableReason,
  }
}
