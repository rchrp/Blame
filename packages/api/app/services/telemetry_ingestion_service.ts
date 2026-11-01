import env from '#start/env'
import type { HttpContext } from '@adonisjs/core/http'

type AdonisRequest = HttpContext['request']

export type TelemetrySignal = 'logs' | 'metrics' | 'traces'

export class TelemetryPayloadTooLargeError extends Error {}

export default class TelemetryIngestionService {
  private readonly maximumPayloadBytes = positiveInteger(
    env.get('BLAME_TELEMETRY_MAX_PAYLOAD_BYTES'),
    4_194_304
  )
  private readonly timeoutMs = positiveInteger(
    env.get('BLAME_TELEMETRY_UPSTREAM_TIMEOUT_MS'),
    10_000
  )

  payloadFits(request: AdonisRequest) {
    const contentLength = Number(request.header('content-length'))
    return !Number.isFinite(contentLength) || contentLength <= this.maximumPayloadBytes
  }

  readPayload(request: AdonisRequest) {
    return readLimitedPayload(request.request, this.maximumPayloadBytes)
  }

  async forward(signal: TelemetrySignal, payload: Buffer) {
    const response = await fetch(upstreamUrl(signal), {
      body: payload,
      headers: {
        ...upstreamHeaders(),
        'content-type': 'application/x-protobuf',
      },
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/x-protobuf',
      status: response.status,
    }
  }
}

async function readLimitedPayload(stream: AdonisRequest['request'], maximumBytes: number) {
  const chunks: Buffer[] = []
  let byteCount = 0
  let tooLarge = false
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    byteCount += chunk.length
    if (byteCount <= maximumBytes) chunks.push(chunk)
    else tooLarge = true
  }
  if (tooLarge) throw new TelemetryPayloadTooLargeError()
  return Buffer.concat(chunks)
}

function upstreamUrl(signal: TelemetrySignal) {
  const url = new URL(requiredTelemetrySetting('BLAME_TELEMETRY_UPSTREAM_ENDPOINT'))
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/${signal}`
  return url.toString()
}

function upstreamHeaders() {
  const configured = env.get('BLAME_TELEMETRY_UPSTREAM_HEADERS')?.release()
  if (!configured) return {}
  return Object.fromEntries(configured.split(',').flatMap(parseHeader))
}

function parseHeader(value: string): Array<[string, string]> {
  const separator = value.indexOf('=')
  if (separator < 1) return []
  const name = value.slice(0, separator).trim()
  const headerValue = decodeHeader(value.slice(separator + 1).trim())
  return name && headerValue ? [[name, headerValue]] : []
}

function decodeHeader(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function positiveInteger(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) throw new Error('Telemetry limit must be positive')
  return value
}

export function requiredTelemetrySetting(
  name: 'BLAME_TELEMETRY_PUBLIC_ENDPOINT' | 'BLAME_TELEMETRY_UPSTREAM_ENDPOINT'
) {
  const value = env.get(name)
  if (!value) throw new Error(`${name} is required to serve telemetry`)
  return value
}
