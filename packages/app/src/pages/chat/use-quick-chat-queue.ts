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
  queuedComments,
  takeQueuedComments,
} from "@/pages/backlog/comment-queue"

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
  cancelAgent,
  chatId,
  send,
}: {
  agentRunning: boolean
  cancelAgent(): Promise<void>
  chatId?: string
  send(message: QueuedMessage): Promise<void>
}) {
  const key = chatId ? `chat:${chatId}` : undefined
  // The message picked with "Send now": it goes out alone once the agent
  // has stopped, the others keep waiting for the next turn to end.
  const sendNow = React.useRef<string | undefined>(undefined)
  const deliver = useLatestCallback(async () => {
    if (!key) return
    const picked = sendNow.current
    sendNow.current = undefined
    const merged = takeQueuedComments(key, picked)
    if (merged) await send(merged)
  })

  React.useEffect(() => {
    if (key && !agentRunning && queuedComments(key).length) void deliver()
  }, [agentRunning, deliver, key])

  const stopAndDeliver = useLatestCallback(
    async (requested: string, commentId: string) => {
      if (requested !== key) return
      sendNow.current = commentId
      if (agentRunning) await cancelAgent()
      else await deliver()
    }
  )
  React.useEffect(
    () =>
      onQueuedDeliveryRequest(
        (requested, commentId) => void stopAndDeliver(requested, commentId)
      ),
    [stopAndDeliver]
  )

  const queue = React.useCallback(
    (message: QueuedMessage) => {
      if (key) queueComment({ ...message, storyId: key })
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
