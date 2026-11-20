import vine from '@vinejs/vine'
import { sessionIdPattern } from '#lib/engine/engine_log_records'

export const listQuickChatsValidator = vine.create({
  projectId: vine.string().trim().minLength(1),
})

export const createQuickChatValidator = vine.create({
  projectId: vine.string().trim().minLength(1),
  title: vine.string().trim().minLength(1).maxLength(255),
  workspace: vine.string().trim().maxLength(2048).nullable().optional(),
  // The engine chooses the session id before the chat exists, so it comes in
  // with the chat, follows the engine's own rule and names one chat only.
  engineSessionId: vine
    .string()
    .regex(sessionIdPattern)
    .unique({ table: 'quick_chats', column: 'engine_session_id' }),
})

export const updateQuickChatValidator = vine.create({
  title: vine.string().trim().minLength(1).maxLength(255).optional(),
  workspace: vine.string().trim().maxLength(2048).nullable().optional(),
})
