import * as React from "react"
import type {
  EngineMessage,
  EngineSessionSettings,
} from "@blame/agent-runtime/engine-protocol"

import { storyMaxInputTokens } from "@/components/backlog/data/story-context-limit"
import { useEngineCompaction } from "@/components/backlog/drawer/story-context-compaction"
import type { QuickChat } from "@/components/chat/data/quick-chat-data"
import { useQuickChatStore } from "@/components/chat/data/quick-chat-store"
import { engineModelChoice } from "@/components/chat/engine/engine-model"
import { transcriptConversation } from "@/components/chat/engine/transcript-conversation"
import type { QueuedMessageControls } from "@/components/chat/engine/queued-messages"
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
        model: engineModelChoice(selection),
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
    return error
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
      engine: platform.engine,
      projectId: created.projectId,
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

  // The queue is the engine's: these act on it, and the transcript shows
  // the result (a withdrawn turn disappears, a promoted one is a steer).
  const queue: QueuedMessageControls = {
    async remove(turn) {
      await platform.engine!.call("withdraw", { session: session!, turn })
    },
    async sendNow(turn) {
      await platform.engine!.call("promote", { session: session!, turn })
    },
    async edit(turn, text) {
      await platform.engine!.call("withdraw", { session: session!, turn })
      await send({ text })
    },
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

  const compactionState = useEngineCompaction({
    available: Boolean(transcript?.items.length),
    running,
    session,
  })

  return {
    compaction: compactionState,
    conversation,
    error: view.error,
    interrupt,
    loaded: !session || view.loaded,
    queue,
    running,
    send,
    transcript,
    undo,
  }
}
