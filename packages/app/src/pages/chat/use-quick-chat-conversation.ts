import * as React from "react"
import type {
  EngineMessage,
  EngineSessionSettings,
} from "@blame/agent-runtime/engine-protocol"
import { engineProviderId } from "@blame/agent-runtime/engine-protocol"

import { storyMaxInputTokens } from "@/components/backlog/data/story-context-limit"
import type { StoryContextCompaction } from "@/components/backlog/drawer/story-context-compaction"
import type { QuickChat } from "@/components/chat/data/quick-chat-data"
import { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import { transcriptConversation } from "@/components/chat/engine/transcript-conversation"
import { useEngineSession } from "@/components/chat/engine/use-engine-session"
import { useModelSelection } from "@/components/model/model-selection"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { chatPersonalization } from "@/lib/agent-personalization"
import {
  chatAmbitionKey,
  conversationAmbitions,
  newChatAmbitionKey,
} from "@/lib/conversation-ambition"
import { projectCodePractices } from "@/lib/project-code-practices"
import {
  generatedQuickChatTitle,
  quickChatSendValidationError,
  titleFromMessage,
} from "./quick-chat-helpers"

/**
 * The active quick chat's conversation and what can be done with it. All of
 * it goes through the engine: the renderer reads records and sends
 * commands, and writes nothing about the conversation itself.
 */
export function useQuickChatConversation(chat: QuickChat | undefined) {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const projects = useProjects()
  const quickChats = useQuickChatStore()
  const selection = useModelSelection({ role: "agent" })
  const project = projects.activeProject
  const session = chat?.engineSessionId ?? undefined
  const view = useEngineSession(session)
  const transcript = view.transcript
  const conversation = React.useMemo(
    () => (transcript ? transcriptConversation(transcript, "You") : undefined),
    [transcript]
  )
  const [compaction, setCompaction] = React.useState<
    { session: string; value: StoryContextCompaction } | undefined
  >()
  const running =
    quickChats.isRunning(chat) ||
    Boolean(transcript?.runningTurn) ||
    (transcript?.activity.state ?? "idle") !== "idle"

  async function settings(target: QuickChat): Promise<EngineSessionSettings> {
    const model = selection.currentModel!
    return {
      purpose: "quick-chat",
      settings: {
        workspaceRoot: target.workspace ?? project!.path,
        projectId: target.projectId,
        model: {
          providerId: model.provider.id,
          modelId: model.id,
          credentialLabel: model.credentialLabel,
          reasoning: selection.currentVariant,
        },
        // The cap picked in the chat's stats panel, like a story's.
        maxContextTokens: storyMaxInputTokens(
          target.id,
          model,
          selection.allProviders
        ),
        personalization: chatPersonalization(target.id),
        codePractices: await projectCodePractices(auth, projects),
      },
    }
  }

  function validationError() {
    const error = quickChatSendValidationError({
      auth,
      model: selection.currentModel,
      platform,
      projectPath: project?.path,
    })
    if (error) return error
    if (!engineProviderId(selection.currentModel!.provider.id))
      return `${selection.currentModel!.provider.name} models do not run on Blame's agent engine yet: pick another model.`
  }

  // A new chat gets its row, then its engine session; the title improves
  // in the background once the model has written one.
  async function startChat(message: string) {
    const created = await quickChats.create({
      title: titleFromMessage(message, project?.name),
      workspace: project?.path ?? null,
    })
    conversationAmbitions.move(newChatAmbitionKey, chatAmbitionKey(created.id))
    try {
      await platform.engine!.call("createSession", {
        session: created.engineSessionId!,
        ...(await settings(created)),
      })
    } catch (error) {
      // A chat without its conversation would be an empty shell.
      await quickChats.remove(created).catch(() => undefined)
      throw error
    }
    quickChats.setActiveId(created.id)
    void generatedQuickChatTitle(message, {
      auth,
      generateTitle: platform.agent?.promptOptimizer.generateTitle,
      projectPath: project?.path,
      selection,
    }).then((title) =>
      title ? quickChats.update(created, { title }) : undefined
    )
    return created
  }

  /** Sends now, queues behind the running turn, or (`steer`) joins it. */
  async function send(message: EngineMessage, steer = false) {
    const error = validationError()
    if (error) throw new Error(error)
    const target = chat?.engineSessionId ? chat : await startChat(message.text)
    // The settings picked now go with the message: the engine host applies
    // them first when they changed (model, reasoning, context cap,
    // personalization, practices), so the turn runs with them.
    await platform.engine!.call("send", {
      session: target.engineSessionId!,
      message,
      delivery: running && steer ? "steer" : "turn",
      settings: await settings(target),
    })
    quickChats.touch(target.id)
  }

  async function interrupt() {
    if (session) await platform.engine!.call("interrupt", { session })
  }

  /** Undoes a message and what followed: the conversation, and the files when they were snapshotted. */
  async function undo(commentId: string) {
    const target = conversation?.rewindTargets.get(commentId)
    if (!session || !target) throw new Error("This message cannot be undone.")
    await platform.engine!.call("rewind", {
      session,
      to: target.to,
      restoreWorkspace: target.workspace,
    })
  }

  const compactionState: StoryContextCompaction = (() => {
    if (!session || !transcript?.items.length || !platform.engine)
      return { status: "unavailable" }
    const shown = compaction?.session === session ? compaction.value : undefined
    if (shown?.status === "compacting") return shown
    if (running)
      return { status: "busy", reason: "Available once the agent pauses." }
    const compact = () => {
      setCompaction({ session, value: { status: "compacting" } })
      void platform
        .engine!.call("compact", { session })
        .then(() => setCompaction({ session, value: { status: "done" } }))
        .catch((error: unknown) =>
          setCompaction({
            session,
            value: {
              status: "failed",
              compact,
              message:
                error instanceof Error ? error.message : "Compaction failed.",
            },
          })
        )
    }
    if (shown?.status === "failed") return { ...shown, compact }
    return shown ?? { status: "idle", compact }
  })()

  return {
    compaction: compactionState,
    conversation,
    error: view.error,
    interrupt,
    loaded: !session || view.loaded,
    running,
    send,
    transcript,
    undo,
  }
}
