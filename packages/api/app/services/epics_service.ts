import EngineLogException from '#lib/engine/engine_log_exception'
import Epic from '#models/epic'
import EngineSession from '#models/engine_session'
import Project from '#models/project'
import EngineSessionsService from '#services/engine_sessions_service'
import ProjectsService from '#services/projects_service'
import type { createEpicValidator, listEpicsValidator, updateEpicValidator } from '#validators/epic'
import db from '@adonisjs/lucid/services/db'
import type { Infer } from '@vinejs/vine/types'

type ListEpicsInput = Infer<typeof listEpicsValidator>
type CreateEpicInput = Infer<typeof createEpicValidator>
type UpdateEpicInput = Infer<typeof updateEpicValidator>

/**
 * Epics of the user's projects. The orchestrator's conversation is the
 * epic's engine session, which the engine pushes on its own; an epic only
 * names it.
 */
export default class EpicsService {
  async list(userId: string, input: ListEpicsInput) {
    await new ProjectsService().findForUser(userId, input.projectId)
    return this.epicQuery(userId)
      .where('projectId', input.projectId)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
  }

  find(userId: string, id: string) {
    return this.epicQuery(userId).where('id', id).firstOrFail()
  }

  async create(userId: string, input: CreateEpicInput) {
    await new ProjectsService().findForUser(userId, input.projectId)
    if (input.engineSessionId) await assertSessionNotForeign(userId, input.engineSessionId)
    const epic = await Epic.create({
      ...input,
      goal: input.goal ?? null,
      status: input.status ?? 'active',
      branch: input.branch ?? null,
      targetBranch: input.targetBranch ?? null,
      engineSessionId: input.engineSessionId ?? null,
      settings: input.settings ?? {},
      mergedAt: input.mergedAt ?? null,
      mergeCommit: input.mergeCommit ?? null,
    })
    return this.find(userId, epic.id)
  }

  async update(userId: string, id: string, input: UpdateEpicInput) {
    if (input.engineSessionId) await assertSessionNotForeign(userId, input.engineSessionId)
    const epic = await this.find(userId, id)
    epic.merge({
      ...input,
      mergedAt: input.mergedAt === undefined ? epic.mergedAt : input.mergedAt,
    })
    await epic.save()
    return this.find(userId, id)
  }

  /**
   * Deletes the epic with its conversation, the engine session. Its stories
   * stay, outside any epic.
   */
  async delete(userId: string, id: string) {
    const epic = await this.find(userId, id)
    // The session goes first, so a failure leaves the epic to delete again
    // instead of a session nothing points to.
    if (epic.engineSessionId) await destroySession(userId, epic.engineSessionId)
    await db.transaction(async (transaction) => {
      await transaction.from('user_stories').where('epic_id', epic.id).update({ epic_id: null })
      epic.useTransaction(transaction)
      await epic.delete()
    })
  }

  private epicQuery(userId: string) {
    return Epic.query().whereIn('projectId', Project.query().select('id').where('userId', userId))
  }
}

/** The engine may push a session before the epic names it: someone else's is not the epic's. */
async function assertSessionNotForeign(userId: string, sessionId: string) {
  const session = await EngineSession.find(sessionId)
  if (session && session.userId !== userId) {
    throw new EngineLogException(
      'E_ENGINE_SESSION_FORBIDDEN',
      'This session belongs to another account',
      403
    )
  }
}

async function destroySession(userId: string, sessionId: string) {
  try {
    await new EngineSessionsService().destroy(userId, sessionId)
  } catch (error) {
    // A session never pushed has no row, and one another account pushed under
    // the same id is not this epic's: either way there is nothing to delete.
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
