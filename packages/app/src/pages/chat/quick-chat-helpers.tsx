import { toast } from "sonner"
import type {
  EngineAttachment,
  EngineMessage,
} from "@blame/agent-runtime/engine-protocol"

import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import {
  codeSelectionLineLabel,
  type PendingCodeSelectionAttachment,
} from "@/components/backlog/shared/comment-attachment-events"
import type { useModelSelection } from "@/components/model/model-selection"
import type { useCloudAuth } from "@/context/cloud-auth"
import type { Platform } from "@/context/platform"
import {
  engineModelChoice,
  generateAgentTitle,
} from "@/lib/agent-title-generation"

export function quickChatSendValidationError(input: {
  auth: ReturnType<typeof useCloudAuth>
  model: ReturnType<typeof useModelSelection>["currentModel"]
  platform: Platform
  projectPath?: string
}) {
  if (!input.projectPath) return "Open a project first."
  if (input.auth.status !== "authenticated")
    return "Reconnect the selected provider."
  if (!input.model) return "Select a model first."
  if (!input.platform.engine) return "The desktop agent engine is not available."
}

/**
 * The message the engine receives. Code excerpts are part of its text, as
 * the model reads them; attached files go as images and documents.
 */
export function quickChatMessage(
  draft: string,
  codeAttachments: PendingCodeSelectionAttachment[],
  fileAttachments: UserStoryFileAttachment[]
): EngineMessage {
  const excerpts = codeAttachments.map(
    (excerpt) =>
      `${excerpt.path}, ${codeSelectionLineLabel(excerpt).toLowerCase()}:\n\n\`\`\`\n${excerpt.content}\n\`\`\``
  )
  const text = [draft.trim(), ...excerpts].filter(Boolean).join("\n\n")
  const attachments = fileAttachments
    .filter((file) => file.content !== undefined)
    .map(
      (file): EngineAttachment => ({
        data: file.content!,
        mediaType: file.type || "application/octet-stream",
        name: file.name,
      })
    )
  return {
    text: text || (attachments.length ? "Attached files" : ""),
    attachments,
  }
}

function defaultQuickChatTitle(projectName: string | undefined) {
  return projectName ? `${projectName} quick change` : "Quick change"
}

export function titleFromMessage(
  message: string,
  projectName: string | undefined
) {
  const fallback = defaultQuickChatTitle(projectName)
  const normalized = message
    .replace(/[#*_`>[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!normalized) return fallback
  if (normalized.length <= 56) return normalized
  return `${normalized.slice(0, 55)}...`
}

// A short title for a new chat, written by the selected model. Undefined
// when it can't be generated (no model, offline…): the chat keeps its draft
// title.
export async function generatedQuickChatTitle(
  message: string,
  input: {
    auth: ReturnType<typeof useCloudAuth>
    engine?: Parameters<typeof generateAgentTitle>[0]
    projectId?: string
    projectPath?: string
    selection: ReturnType<typeof useModelSelection>
  }
) {
  const model = engineModelChoice(input.selection)
  if (
    !input.engine ||
    !model ||
    !input.projectPath ||
    input.auth.status !== "authenticated"
  )
    return undefined
  try {
    return await generateAgentTitle(input.engine, {
      context: "quick-chat",
      model,
      projectId: input.projectId,
      prompt: message,
      workspace: input.projectPath,
    })
  } catch {
    // A used-up plan shows on the chat's own failed turn.
    return undefined
  }
}

export function openProjectPath(
  root: string | undefined,
  path: string,
  openPath: ((path: string) => Promise<string>) | undefined
) {
  if (!openPath) return
  const target = path.startsWith("/") || !root ? path : `${root}/${path}`
  void openPath(target)
}

export function showQuickChatError(title: string, description: string) {
  toast.error(title, {
    description,
    position: "bottom-right",
  })
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
