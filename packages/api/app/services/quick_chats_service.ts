import EngineLogException from '#lib/engine/engine_log_exception'
import EngineSession from '#models/engine_session'
import Project from '#models/project'
import QuickChat from '#models/quick_chat'
import EngineSessionsService from '#services/engine_sessions_service'
import ProjectsService from '#services/projects_service'
import type {
  createQuickChatValidator,
  listQuickChatsValidator,
  updateQuickChatValidator,
} from '#validators/quick_chat'
import db from '@adonisjs/lucid/services/db'
import type { Infer } from '@vinejs/vine/types'

type ListQuickChatsInput = Infer<typeof listQuickChatsValidator>
type CreateQuickChatInput = Infer<typeof createQuickChatValidator>
type UpdateQuickChatInput = Infer<typeof updateQuickChatValidator>

// The later of the chat's own last change and the last push of its engine
// session: a chat is active when someone talks in it, not only when renamed.
const chatUpdatedAt = 'COALESCE(quick_chats.updated_at, quick_chats.created_at)'
const lastActivityAt = `CASE WHEN engine_sessions.updated_at > ${chatUpdatedAt} THEN engine_sessions.updated_at ELSE ${chatUpdatedAt} END`

/**
 * Quick chats of the user's projects. The conversation itself is the chat's
 * engine session, which the engine pushes on its own; a chat only names it.
 */
export default class QuickChatsService {
  async list(userId: string, input: ListQuickChatsInput) {
    await new ProjectsService().findForUser(userId, input.projectId)
    return this.quickChatQuery(userId)
      .where('quick_chats.project_id', input.projectId)
      .orderBy('last_activity_at', 'desc')
      .orderBy('quick_chats.created_at', 'desc')
      .orderBy('quick_chats.id', 'desc')
  }

  find(userId: string, id: string) {
    return this.quickChatQuery(userId).where('quick_chats.id', id).firstOrFail()
  }

  async create(userId: string, input: CreateQuickChatInput) {
    await new ProjectsService().findForUser(userId, input.projectId)
    // The engine may have pushed the session before the chat is created; a
    // session of someone else's is not this chat's conversation.
    const session = await EngineSession.find(input.engineSessionId)
    if (session && session.userId !== userId) {
      throw new EngineLogException(
        'E_ENGINE_SESSION_FORBIDDEN',
        'This session belongs to another account',
        403
      )
    }
    const quickChat = await QuickChat.create({
      projectId: input.projectId,
      title: input.title,
      workspace: input.workspace ?? null,
      engineSessionId: input.engineSessionId,
    })
    return this.find(userId, quickChat.id)
  }

  async update(userId: string, id: string, input: UpdateQuickChatInput) {
    const quickChat = await this.find(userId, id)
    quickChat.merge(input)
    await quickChat.save()
    return this.find(userId, id)
  }

  /** Deletes the chat with its conversation, the engine session. */
  async delete(userId: string, id: string) {
    const quickChat = await this.find(userId, id)
    // The session goes first, so a failure leaves the chat to delete again
    // instead of a session nothing points to.
    if (quickChat.engineSessionId) {
      await destroySession(userId, quickChat.engineSessionId)
    }
    await quickChat.delete()
  }

  private quickChatQuery(userId: string) {
    return QuickChat.query()
      .select('quick_chats.*')
      .select(db.raw(`${lastActivityAt} as last_activity_at`))
      .leftJoin('engine_sessions', (join) => {
        join
          .on('engine_sessions.id', 'quick_chats.engine_session_id')
          .andOnVal('engine_sessions.user_id', userId)
      })
      .whereIn('quick_chats.project_id', Project.query().select('id').where('userId', userId))
  }
}

async function destroySession(userId: string, sessionId: string) {
  try {
    await new EngineSessionsService().destroy(userId, sessionId)
  } catch (error) {
    // A session never pushed has no row, and one another account pushed under
    // the same id is not this chat's: either way there is nothing to delete.
    if (
      error instanceof EngineLogException &&
      (error.engineCode === 'E_ENGINE_SESSION_NOT_FOUND' ||
        error.engineCode === 'E_ENGINE_SESSION_FORBIDDEN')
    ) {
      return
    }
    throw error
  }
}
