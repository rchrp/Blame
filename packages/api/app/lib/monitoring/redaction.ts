import type { Attributes, AttributeValue } from '@opentelemetry/api'

// What leaves the API: bounded attributes, never secrets, request content,
// paths or free-form error messages.

const maximumAttributeCount = 64
const maximumStringLength = 1_024
const blockedKeyPattern =
  /(?:^|[._-])(?:api[._-]?key|authorization|command|content|cookie|credential|env|password|prompt|secret|stderr|stdout|access[._-]?token|refresh[._-]?token)(?:$|[._-])/i
const blockedValueReplacements: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
  [
    /\b(?:api[_-]?key|access[_-]?token|authorization|password|refresh[_-]?token|secret|token)\s*[=:]\s*[^\s,;]+/gi,
    '[REDACTED]',
  ],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
]
export const metricAttributeKeys = [
  'blame.operation.status',
  'blame.runtime.name',
  'blame.runtime.phase',
]
const privateTraceKeyPattern =
  /^(?:client\.(?:address|port)|code\.(?:file\.path|stacktrace)|db\.(?:collection\.name|namespace|query\.(?:summary|text)|statement|user)|error\.message|exception\.(?:message|stacktrace)|file\.path|http\.(?:request|response)\.header\..+|http\.(?:target|url|user_agent)|log\.file\.path|network\.peer\.(?:address|port)|process\.(?:command|command_args|command_line|executable\.path)|url\.(?:full|original|path|query)|user_agent\.original)$/i

export function sanitizeAttributes(input: Record<string, unknown> = {}) {
  const attributes: Attributes = {}
  for (const [key, value] of Object.entries(input).slice(0, maximumAttributeCount)) {
    if (blockedKeyPattern.test(key)) continue
    const sanitized = sanitizeAttributeValue(value)
    if (sanitized !== undefined) attributes[key] = sanitized
  }
  return attributes
}

export function metricAttributes(input: Record<string, unknown> = {}) {
  return sanitizeAttributes(
    Object.fromEntries(Object.entries(input).filter(([key]) => metricAttributeKeys.includes(key)))
  )
}

export function traceAttributes(input: Record<string, unknown> = {}) {
  const attributes = sanitizeAttributes(
    Object.fromEntries(Object.entries(input).filter(([key]) => !privateTraceKeyPattern.test(key)))
  )
  for (const key of ['error.type', 'exception.type']) {
    const value = attributes[key]
    if (typeof value === 'string') attributes[key] = boundedErrorType(value)
  }
  return attributes
}

export function errorAttributes(error: unknown) {
  const type = error instanceof Error ? boundedErrorType(error.name) : 'Error'
  return { 'error.type': type, 'exception.type': type }
}

export function boundedErrorType(value: string) {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : 'Error'
}

export function sanitizeText(value: string) {
  return blockedValueReplacements
    .reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value)
    .slice(0, maximumStringLength)
}

function sanitizeAttributeValue(value: unknown): AttributeValue | undefined {
  if (typeof value === 'string') return sanitizeText(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  if (!Array.isArray(value)) return undefined
  if (value.every((entry): entry is string => typeof entry === 'string')) {
    return value.map(sanitizeText)
  }
  if (value.every((entry): entry is number => typeof entry === 'number')) {
    return value.filter((entry) => Number.isFinite(entry))
  }
  if (value.every((entry): entry is boolean => typeof entry === 'boolean')) return value
  return undefined
}
