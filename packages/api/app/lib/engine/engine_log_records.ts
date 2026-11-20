import EngineLogException from '#lib/engine/engine_log_exception'

/** One record of a push, checked just enough to be stored and indexed. */
export type ParsedRecord = {
  seq: number
  atMs: number
  type: string
  /** The record as the engine sent it, serialized once and never rewritten. */
  body: string
  value: Record<string, unknown>
}

const sessionIdPattern = /^[A-Za-z0-9._:-]{1,64}$/
const sha256Pattern = /^[0-9a-f]{64}$/
export const maxSafeSeq = Number.MAX_SAFE_INTEGER

export function assertSessionId(id: string) {
  if (!sessionIdPattern.test(id)) {
    throw invalid('A session id is 1 to 64 characters of letters, digits and . _ : -')
  }
  return id
}

export function assertSha256(value: string) {
  if (!sha256Pattern.test(value)) throw invalid('A blob hash is 64 lowercase hex characters')
  return value
}

/**
 * Checks that `records` is a non-empty-or-empty list of records with
 * contiguous ascending seqs, the shape the engine's store always sends.
 */
export function parseRecords(input: unknown, maxRecords: number): ParsedRecord[] {
  if (!Array.isArray(input)) throw invalid('records must be an array')
  if (input.length > maxRecords) {
    throw new EngineLogException(
      'E_ENGINE_PAYLOAD_TOO_LARGE',
      `A push carries at most ${maxRecords} records`,
      413
    )
  }
  const records = input.map(parseRecord)
  for (let index = 1; index < records.length; index++) {
    if (records[index]!.seq !== records[index - 1]!.seq + 1) {
      throw invalid('Records must be contiguous and ascending')
    }
  }
  return records
}

function parseRecord(value: unknown, index: number): ParsedRecord {
  if (!isObject(value)) throw invalid(`records[${index}] must be an object`)
  const { seq, at_ms: atMs, type } = value
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) {
    throw invalid(`records[${index}].seq must be an integer from 1`)
  }
  if (!Number.isSafeInteger(atMs) || (atMs as number) < 0) {
    throw invalid(`records[${index}].at_ms must be a non-negative integer`)
  }
  if (typeof type !== 'string' || !type || type.length > 64) {
    throw invalid(`records[${index}].type must be a string of at most 64 characters`)
  }
  return {
    seq: seq as number,
    atMs: atMs as number,
    type,
    body: JSON.stringify(value),
    value,
  }
}

/** What the session is for, from the `session_created` record every log starts with. */
export function purposeOf(record: ParsedRecord) {
  if (record.type !== 'session_created') return null
  const config = record.value.config
  if (!isObject(config) || typeof config.purpose !== 'string') return null
  return config.purpose.slice(0, 64)
}

/**
 * The blobs a record points to: every `BlobRef` object (`sha256`,
 * `media_type`, `bytes`) found anywhere inside it.
 */
export function blobHashes(value: unknown, found = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const entry of value) blobHashes(entry, found)
  } else if (isObject(value)) {
    if (
      typeof value.sha256 === 'string' &&
      typeof value.media_type === 'string' &&
      sha256Pattern.test(value.sha256)
    ) {
      found.add(value.sha256)
    }
    for (const entry of Object.values(value)) blobHashes(entry, found)
  }
  return found
}

/** Key order and spacing do not make two records different. */
export function sameRecord(stored: string, incoming: ParsedRecord) {
  if (stored === incoming.body) return true
  try {
    return canonical(JSON.parse(stored)) === canonical(incoming.value)
  } catch {
    return false
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function invalid(message: string) {
  return new EngineLogException('E_ENGINE_INVALID_REQUEST', message, 422)
}
