import * as React from "react"

import type {
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import type { useModelSelection } from "@/components/model/model-selection"
import type { useCloudAuth } from "@/context/cloud-auth"
import { generateAgentTitle } from "@/lib/agent-title-generation"
import { useLatestCallback } from "@/lib/use-latest-callback"
import {
  onQueuedDeliveryRequest,
  queueComment,
  requestQueuedDelivery,
  useQueuedComments,
} from "@/pages/backlog/comment-queue"
import { QuickChatQueueDelivery } from "./quick-chat-queue-delivery"

type QueuedMessage = {
  body: string
  codeSelectionAttachments: UserStoryCodeSelectionAttachment[]
  fileAttachments: UserStoryFileAttachment[]
}

// Messages written in a quick chat while its agent works: they wait and go
// out together when it finishes. "Send now" on one of them stops the agent
// first, so it reads that message right away.
export function useQuickChatQueue({
  agentRunning,
  busy,
  cancelAgent,
  chatId,
  onError,
  paused,
  send,
}: {
  agentRunning: boolean
  busy: boolean
  paused: boolean
  cancelAgent(chatId: string): Promise<unknown>
  chatId?: string
  onError(error: unknown): void
  send(chatId: string, message: QueuedMessage): Promise<void>
}) {
  const key = chatId ? `chat:${chatId}` : undefined
  const queued = useQueuedComments(key)
  const [delivery] = React.useState(() => new QuickChatQueueDelivery())
  const deliver = useLatestCallback(async (commentId?: string) => {
    if (!chatId) return
    try {
      await delivery.deliver({
        chatId,
        commentId,
        automatic: !commentId,
        stop: commentId && agentRunning ? cancelAgent : undefined,
        send,
      })
    } catch (error) {
      onError(error)
    }
  })

  React.useEffect(() => {
    if (key && !agentRunning && !busy && !paused && queued.length)
      void deliver()
  }, [agentRunning, busy, deliver, key, paused, queued])

  const stopAndDeliver = useLatestCallback(
    async (requested: string, commentId: string) => {
      if (requested !== key) return
      await deliver(commentId)
    }
  )
  React.useEffect(
    () =>
      onQueuedDeliveryRequest(
        (requested, commentId) => void stopAndDeliver(requested, commentId)
      ),
    [stopAndDeliver]
  )

  // sendNow (⌘↵) queues the message and sends it right away.
  const queue = React.useCallback(
    (message: QueuedMessage, sendNow = false) => {
      if (!key) return
      const queued = queueComment({ ...message, storyId: key })
      if (sendNow) requestQueuedDelivery(key, queued.id)
    },
    [key]
  )
  return { key, queue }
}

// A short title for a new chat, written by the selected model. Undefined
// when it can't be generated (no model, offline…): the chat keeps its draft
// title.
export async function generatedQuickChatTitle(
  message: string,
  input: {
    auth: ReturnType<typeof useCloudAuth>
    generateTitle?: Parameters<typeof generateAgentTitle>[0]
    projectPath?: string
    selection: ReturnType<typeof useModelSelection>
  }
) {
  const model = input.selection.currentModel
  if (
    !input.generateTitle ||
    !model ||
    !input.projectPath ||
    input.auth.status !== "authenticated"
  )
    return undefined
  try {
    return await generateAgentTitle(input.generateTitle, {
      apiConnection: input.auth.apiConnection,
      context: "quick-chat",
      providerId: model.provider.id,
      modelId: model.id,
      credentialLabel: model.credentialLabel,
      reasoningEffort: input.selection.currentVariant,
      prompt: message,
      workspace: input.projectPath,
    })
  } catch {
    return undefined
  }
}
