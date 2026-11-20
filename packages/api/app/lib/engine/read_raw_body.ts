import EngineLogException from '#lib/engine/engine_log_exception'
import type { HttpContext } from '@adonisjs/core/http'

const rawContentType = 'application/octet-stream'

/**
 * The request body exactly as sent, up to `maxBytes`.
 *
 * Engine requests carry their payload as `application/octet-stream`, which the
 * body parser leaves alone. It must: its JSON parser turns every empty string
 * into `null`, and records are stored unchanged (an empty reasoning summary is
 * a valid record). Reading the stream here also gives the endpoint its own
 * size limit instead of the 20 MB one of the JSON parser.
 */
export async function readRawBody(request: HttpContext['request'], maxBytes: number) {
  const contentType = request.header('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== rawContentType) {
    throw new EngineLogException('E_ENGINE_CONTENT_TYPE', `Send the body as ${rawContentType}`, 415)
  }
  const declared = Number(request.header('content-length') ?? 0)
  if (declared > maxBytes) throw tooLarge(maxBytes)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request.request as AsyncIterable<Buffer>) {
    total += chunk.byteLength
    if (total > maxBytes) throw tooLarge(maxBytes)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

function tooLarge(maxBytes: number) {
  return new EngineLogException(
    'E_ENGINE_PAYLOAD_TOO_LARGE',
    `The body is at most ${maxBytes} bytes`,
    413
  )
}
