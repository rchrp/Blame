import { engineSessionsConfig } from '#config/engine_sessions'
import { assertSessionId, invalid, isObject } from '#lib/engine/engine_log_records'
import { readRawBody } from '#lib/engine/read_raw_body'
import EngineSessionsService from '#services/engine_sessions_service'
import { listEngineSessionsValidator, pullEngineRecordsValidator } from '#validators/engine_session'
import type { HttpContext } from '@adonisjs/core/http'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The durable copy of the agent engine's session logs. The desktop relays the
 * engine's `host/log/push` and `host/log/pull` here with the user's own token.
 */
export default class EngineSessionsController {
  async index({ auth, request }: HttpContext) {
    const { limit } = await request.validateUsing(listEngineSessionsValidator)
    const sessions = await new EngineSessionsService().list(auth.getUserOrFail().id, limit)
    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        purpose: session.purpose,
        projectId: session.projectId,
        head: session.headSeq,
        createdAt: session.createdAt.toISO(),
        updatedAt: session.updatedAt.toISO(),
      })),
    }
  }

  async push({ auth, params, request }: HttpContext) {
    const sessionId = assertSessionId(params.id)
    const body = await readRawBody(request, engineSessionsConfig().maxPushBytes)
    const input = parseJson(body)
    if (!isObject(input)) throw invalid('The body must be a JSON object')
    const { projectId } = input
    if (
      projectId !== undefined &&
      projectId !== null &&
      (typeof projectId !== 'string' || !uuidPattern.test(projectId))
    ) {
      throw invalid('projectId must be a project id')
    }
    return new EngineSessionsService().push(auth.getUserOrFail().id, sessionId, {
      records: input.records,
      projectId,
    })
  }

  async pull({ auth, params, request, response }: HttpContext) {
    const sessionId = assertSessionId(params.id)
    const { after, limit } = await request.validateUsing(pullEngineRecordsValidator)
    const page = await new EngineSessionsService().pull(
      auth.getUserOrFail().id,
      sessionId,
      after ?? 0,
      limit
    )
    // Records go out as stored, not parsed and written again.
    response.header('content-type', 'application/json; charset=utf-8')
    return response.send(
      `{"records":[${page.bodies.join(',')}],"head":${page.head},"hasMore":${page.hasMore}}`
    )
  }

  async destroy({ auth, params, response }: HttpContext) {
    await new EngineSessionsService().destroy(auth.getUserOrFail().id, assertSessionId(params.id))
    return response.noContent()
  }
}

function parseJson(body: Buffer) {
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    throw invalid('The body is not valid JSON')
  }
}
