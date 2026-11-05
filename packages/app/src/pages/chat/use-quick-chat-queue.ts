import * as React from "react"

import type {
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import type { useModelSelection } from "@/components/model/model-selection"
import type { useCloudAuth } from "@/context/cloud-auth"
import { generateAgentTitle } from "@/lib/agent-title-generation"
import {
  queueComment,
  requestQueuedDelivery,
} from "@/pages/backlog/comment-queue"

type QueuedMessage = {
  body: string
  codeSelectionAttachments: UserStoryCodeSelectionAttachment[]
  fileAttachments: UserStoryFileAttachment[]
}

const queueKeyPrefix = "chat:"

export function quickChatQueueKey(chatId: string) {
  return `${queueKeyPrefix}${chatId}`
}

export function quickChatQueueChatId(key: string) {
  return key.startsWith(queueKeyPrefix)
    ? key.slice(queueKeyPrefix.length) || undefined
    : undefined
}

// Messages written in a quick chat while its agent works wait in the comment
// queue. The quick chat agent runner sends them when the agent finishes, or
// right away on "Send now" (it stops the agent first), whether or not the
// chat is open.
export function useQuickChatComposerQueue(chatId?: string) {
  const key = chatId ? quickChatQueueKey(chatId) : undefined
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
