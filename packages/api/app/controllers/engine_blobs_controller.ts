import { engineSessionsConfig } from '#config/engine_sessions'
import { assertSha256 } from '#lib/engine/engine_log_records'
import { readRawBody } from '#lib/engine/read_raw_body'
import EngineSessionsService from '#services/engine_sessions_service'
import { storeEngineBlobValidator } from '#validators/engine_session'
import type { HttpContext } from '@adonisjs/core/http'

/** Bytes the engine's records point to (images, large tool output), by SHA-256. */
export default class EngineBlobsController {
  async store({ auth, params, request, response }: HttpContext) {
    const sha256 = assertSha256(params.sha256)
    const { mediaType } = await request.validateUsing(storeEngineBlobValidator)
    const bytes = await readRawBody(request, engineSessionsConfig().maxBlobBytes)
    const stored = await new EngineSessionsService().putBlob(
      auth.getUserOrFail().id,
      sha256,
      mediaType,
      bytes
    )
    return response.status(stored.created ? 201 : 200).send({
      sha256,
      size: stored.size,
      mediaType: stored.mediaType,
    })
  }

  async show({ auth, params, response }: HttpContext) {
    const blob = await new EngineSessionsService().blob(
      auth.getUserOrFail().id,
      assertSha256(params.sha256)
    )
    response.header('content-type', 'application/octet-stream')
    response.header('x-blob-media-type', blob.mediaType)
    response.header('cache-control', 'private, max-age=31536000, immutable')
    return response.send(blob.bytes)
  }
}
