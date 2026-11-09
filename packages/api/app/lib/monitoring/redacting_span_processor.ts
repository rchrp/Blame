import type { Context } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace'
import { traceAttributes } from '#lib/monitoring/redaction'

const httpInstrumentationNames = new Set([
  '@opentelemetry/instrumentation-http',
  '@opentelemetry/instrumentation-undici',
])
const mysqlInstrumentationName = '@opentelemetry/instrumentation-mysql2'
const sqlOperations = new Set([
  'ALTER',
  'CALL',
  'CREATE',
  'DELETE',
  'DROP',
  'INSERT',
  'REPLACE',
  'SELECT',
  'SHOW',
  'TRUNCATE',
  'UPDATE',
])

// Applies the redaction rules to automatic HTTP and database spans before
// export, and names them by method or SQL operation, never by URL or query.
export class RedactingSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context) {}

  onEnding(span: Span) {
    replaceAttributes(span.attributes)
    span.events.forEach((event) => replaceOptionalAttributes(event))
    span.links.forEach((link) => replaceOptionalAttributes(link))
    delete span.attributes['error.message']
    delete span.attributes['exception.message']
    span.events.forEach((event) => {
      if (event.attributes) delete event.attributes['exception.message']
    })
    span.setStatus({ code: span.status.code })
    if (httpInstrumentationNames.has(span.instrumentationScope.name)) {
      span.updateName(httpSpanName(span.attributes))
    }
    if (span.instrumentationScope.name === mysqlInstrumentationName) {
      span.updateName(sqlSpanName(span.name))
    }
  }

  onEnd(_span: ReadableSpan) {}

  forceFlush() {
    return Promise.resolve()
  }

  shutdown() {
    return Promise.resolve()
  }
}

export function httpSpanName(attributes: Record<string, unknown>) {
  const value = attributes['http.request.method'] ?? attributes['http.method']
  if (typeof value !== 'string') return 'HTTP'
  const method = value.toUpperCase()
  return /^[A-Z]{3,16}$/.test(method) ? method : 'HTTP'
}

export function sqlSpanName(value: string) {
  const operation = value.trim().split(/\s+/, 1)[0]?.toUpperCase()
  return operation && sqlOperations.has(operation) ? operation : 'SQL'
}

function replaceOptionalAttributes(target: { attributes?: Record<string, unknown> }) {
  if (target.attributes) replaceAttributes(target.attributes)
}

function replaceAttributes(attributes: Record<string, unknown>) {
  const sanitized = traceAttributes(attributes)
  Object.keys(attributes).forEach((key) => delete attributes[key])
  Object.assign(attributes, sanitized)
}
