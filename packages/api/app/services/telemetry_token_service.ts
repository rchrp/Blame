import { createHmac, timingSafeEqual } from 'node:crypto'
import env from '#start/env'

type TelemetryTokenClaims = {
  aud: 'blame-telemetry'
  exp: number
  iat: number
  iss: 'blame-api'
  scope: 'telemetry:write'
  sub: string
  ver: 1
}

type TelemetryTokenOptions = {
  now?: () => number
  secret: string
  ttlSeconds: number
}

export type TelemetryTokenSession = {
  expiresAt: string
  token: string
}

export default class TelemetryTokenService {
  private readonly now: () => number

  constructor(private readonly options: TelemetryTokenOptions = configuredOptions()) {
    this.now = options.now ?? Date.now
  }

  issue(subject: string): TelemetryTokenSession {
    const issuedAt = Math.floor(this.now() / 1000)
    const claims: TelemetryTokenClaims = {
      aud: 'blame-telemetry',
      exp: issuedAt + this.options.ttlSeconds,
      iat: issuedAt,
      iss: 'blame-api',
      scope: 'telemetry:write',
      sub: subject,
      ver: 1,
    }
    const token = this.sign(claims)
    return { expiresAt: new Date(claims.exp * 1000).toISOString(), token }
  }

  verify(token: string): TelemetryTokenClaims | null {
    const segments = token.split('.')
    if (segments.length !== 3 || !segments.every(validSegment)) return null
    const [header, payload, providedSignature] = segments
    if (!this.validSignature(`${header}.${payload}`, providedSignature)) return null
    const decodedHeader = decodeSegment(header)
    const claims = decodeSegment(payload)
    if (!validHeader(decodedHeader) || !validClaims(claims)) return null
    return this.validLifetime(claims) ? claims : null
  }

  private sign(claims: TelemetryTokenClaims) {
    const header = encodeSegment({ alg: 'HS256', typ: 'JWT' })
    const payload = encodeSegment(claims)
    const signature = signatureFor(`${header}.${payload}`, this.options.secret)
    return `${header}.${payload}.${signature}`
  }

  private validSignature(value: string, provided: string) {
    const expected = Buffer.from(signatureFor(value, this.options.secret))
    const actual = Buffer.from(provided)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  private validLifetime(claims: TelemetryTokenClaims) {
    const now = Math.floor(this.now() / 1000)
    return claims.iat <= now + 30 && claims.exp > now && claims.exp > claims.iat
  }
}

function configuredOptions(): TelemetryTokenOptions {
  const secret = env.get('BLAME_TELEMETRY_TOKEN_SECRET')?.release() ?? ''
  const ttlSeconds = env.get('BLAME_TELEMETRY_TOKEN_TTL_SECONDS') ?? 900
  if (Buffer.byteLength(secret) < 32) throw new Error('Telemetry token secret is too short')
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 3600) {
    throw new Error('Telemetry token TTL must be between 300 and 3600 seconds')
  }
  return {
    secret,
    ttlSeconds,
  }
}

function signatureFor(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function encodeSegment(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeSegment(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function validSegment(value: string) {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value)
}

function validHeader(value: unknown) {
  return isRecord(value) && value.alg === 'HS256' && value.typ === 'JWT'
}

function validClaims(value: unknown): value is TelemetryTokenClaims {
  if (!isRecord(value)) return false
  return (
    value.aud === 'blame-telemetry' &&
    value.iss === 'blame-api' &&
    value.scope === 'telemetry:write' &&
    value.ver === 1 &&
    typeof value.sub === 'string' &&
    value.sub.length > 0 &&
    typeof value.iat === 'number' &&
    Number.isInteger(value.iat) &&
    typeof value.exp === 'number' &&
    Number.isInteger(value.exp)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}
