import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'

export type EngineLogErrorCode =
  | 'E_ENGINE_BLOB_HASH_MISMATCH'
  | 'E_ENGINE_BLOB_NOT_FOUND'
  | 'E_ENGINE_CONTENT_TYPE'
  | 'E_ENGINE_INVALID_REQUEST'
  | 'E_ENGINE_LOG_CONFLICT'
  | 'E_ENGINE_LOG_GAP'
  | 'E_ENGINE_PAYLOAD_TOO_LARGE'
  | 'E_ENGINE_PROJECT_NOT_FOUND'
  | 'E_ENGINE_SESSION_FORBIDDEN'
  | 'E_ENGINE_SESSION_NOT_FOUND'

/**
 * An engine log request the API refuses. The body is always
 * `{ code, message, ...details }`: the desktop reads `code`, and a gap or a
 * conflict also says where the stored log stands.
 */
export default class EngineLogException extends Exception {
  constructor(
    readonly engineCode: EngineLogErrorCode,
    message: string,
    status: number,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message, { code: engineCode, status })
  }

  async handle(error: EngineLogException, { response }: HttpContext) {
    response
      .status(error.status)
      .send({ code: error.engineCode, message: error.message, ...error.details })
  }
}
