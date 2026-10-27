import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import {
  PreviewRuntimeError,
  type PreviewExecutionPlan,
  type RuntimeHandle,
  type RuntimeObservation,
} from '@blame/preview-runtime'

export type VercelRuntimeHandle = {
  kind: 'vercel-sandbox'
  sandboxName: string
  sessionId: string
  generation: number
  fencingToken: number
  gatewayPorts: number[]
  resourceVcpus?: number
}

export type VercelPlan = 'hobby' | 'pro' | 'enterprise'

export type RunnerCallOptions = {
  busyProviderCode?: string
  lockWaitSeconds?: number
  timeoutMs?: number
}

export const backgroundRunnerBusyProviderCode = 'BACKGROUND_RUNNER_BUSY'

export function backgroundRunnerCallOptions(background: boolean) {
  return background
    ? {
        busyProviderCode: backgroundRunnerBusyProviderCode,
        lockWaitSeconds: 1,
        timeoutMs: 5_000,
      }
    : undefined
}

export function vercelPlanLimits(plan: VercelPlan) {
  return plan === 'hobby'
    ? { maxDurationMinutes: 45, maxVcpus: 4 }
    : plan === 'pro'
      ? { maxDurationMinutes: 24 * 60, maxVcpus: 8 }
      : { maxDurationMinutes: 24 * 60, maxVcpus: 32 }
}

export function effectiveSandboxTimeoutMinutes(requestedMinutes: number, plan: VercelPlan) {
  return Math.min(requestedMinutes, vercelPlanLimits(plan).maxDurationMinutes)
}

export function vercelHandle(handle: RuntimeHandle): VercelRuntimeHandle {
  const value = handle as unknown as Partial<VercelRuntimeHandle>
  if (
    value.kind !== 'vercel-sandbox' ||
    !value.sandboxName ||
    !value.sessionId ||
    !Number.isSafeInteger(value.fencingToken) ||
    Number(value.fencingToken) < 1
  ) {
    throw new Error('Invalid Vercel runtime handle.')
  }
  return value as VercelRuntimeHandle
}

export function desiredPorts(plan: PreviewExecutionPlan) {
  const ports = Array.from(
    new Set(plan.networking.gatewayListeners.map(({ sandboxPort }) => sandboxPort))
  )
  if (ports.length !== plan.networking.publishedPortCount || ports.length > 15) {
    throw new PreviewRuntimeError({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'The preview gateway port plan is invalid.',
      retryable: false,
    })
  }
  return ports
}

export function inactiveObservation(
  generation: number,
  host: RuntimeObservation['host'],
  engine: RuntimeObservation['engine']
): RuntimeObservation {
  return { host, engine, generation, services: [] }
}

export function sandboxNameFor(sessionId: string) {
  return `blame-${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`
}

export function shortTag(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

export function ownedSnapshotIdForDeletion(
  status: 'pending' | 'running' | 'stopping' | 'stopped' | 'failed' | 'aborted' | 'snapshotting',
  currentSnapshotId?: string
) {
  return ['stopped', 'aborted', 'failed'].includes(status) ? currentSnapshotId : undefined
}

export function runnerFailure(code: string, message: string) {
  return new PreviewRuntimeError({
    code: /HEALTH|PROBE/.test(code) ? 'HEALTHCHECK_FAILED' : 'ENGINE_START_FAILED',
    message,
    providerCode: code,
    retryable: false,
  })
}

export function providerFailure(operation: string, error: unknown) {
  const status = providerStatus(error)
  const code =
    operation === 'baseline-restore' && providerSnapshotMissing(error)
      ? 'BASELINE_SNAPSHOT_NOT_FOUND'
      : status === 404
        ? 'SANDBOX_NOT_FOUND'
        : providerCode(error)
  const reason = providerMessage(error)
  return new PreviewRuntimeError({
    code:
      status === 401 || status === 403
        ? 'PROVIDER_AUTH'
        : status === 429
          ? 'PROVIDER_QUOTA'
          : 'PROVIDER_UNAVAILABLE',
    message: `Vercel Sandbox ${operation} failed${reason ? `: ${reason}` : '.'}`,
    providerCode: code.slice(0, 80),
    correlationId: providerRequestId(error)?.slice(0, 120),
    retryable: status === 429 || status >= 500 || status === 0,
  })
}

export function retryableProviderError(error: unknown) {
  const status = providerStatus(error)
  return (
    status === 0 ||
    status === 429 ||
    status >= 500 ||
    providerCode(error) === 'SANDBOX_SNAPSHOTTING'
  )
}

export function providerResourceMissing(error: unknown) {
  if (error instanceof PreviewRuntimeError) {
    return error.failure.providerCode === 'SANDBOX_NOT_FOUND'
  }
  return providerStatus(error) === 404 || providerCode(error).includes('NOT_FOUND')
}

export function providerSnapshotMissing(error: unknown) {
  if (error instanceof PreviewRuntimeError) {
    return error.failure.providerCode === 'BASELINE_SNAPSHOT_NOT_FOUND'
  }
  const status = providerStatus(error)
  const code = providerCode(error).toUpperCase()
  if (status === 404 || code.includes('SNAPSHOT_NOT_FOUND')) return true
  if (status < 400 || status >= 500) return false
  const message = providerMessage(error)?.toLowerCase() ?? ''
  return (
    message.includes('snapshot') &&
    ['expired', 'deleted', 'not found', 'does not exist'].some((reason) => message.includes(reason))
  )
}

function providerStatus(error: unknown) {
  const details = objectValue(error)
  const response = objectValue(details?.response)
  return Number(response?.status ?? details?.status ?? details?.statusCode ?? 0)
}

function providerCode(error: unknown) {
  const details = objectValue(error)
  const json = objectValue(details?.json)
  const bodyError = objectValue(json?.error)
  const cause = objectValue(details?.cause)
  return String(bodyError?.code ?? json?.code ?? details?.code ?? cause?.code ?? 'VERCEL_UNKNOWN')
}

function providerRequestId(error: unknown) {
  const details = objectValue(error)
  const json = objectValue(details?.json)
  const bodyError = objectValue(json?.error)
  const headers = objectValue(objectValue(details?.response)?.headers) as
    { get?: (name: string) => string | null } | undefined
  const header = headers?.get?.('x-vercel-id') ?? headers?.get?.('x-request-id')
  const value = bodyError?.requestId ?? json?.requestId ?? details?.requestId ?? header
  return typeof value === 'string' ? value : undefined
}

function providerMessage(error: unknown) {
  const details = objectValue(error)
  const json = objectValue(details?.json)
  const bodyError = objectValue(json?.error)
  const value = bodyError?.message ?? json?.message ?? details?.text
  if (typeof value !== 'string') return undefined
  const sanitized = value
    .replace(/https?:\/\/[^\s"']+/gi, '[redacted-url]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bvcp_[A-Za-z0-9._-]+\b/g, '[redacted-token]')
    .replace(
      /\b(access[_-]?token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    )
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized ? sanitized.slice(0, 240) : undefined
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

export function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function capabilityKeysMatch(publicPem: string | undefined, privatePem: string | undefined) {
  if (!publicPem || !privatePem) return false
  try {
    const privateKey = createPrivateKey(privatePem)
    const publicKey = createPublicKey(publicPem)
    if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
      return false
    }
    const expected = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    const actual = publicKey.export({ type: 'spki', format: 'der' })
    return expected.equals(actual)
  } catch {
    return false
  }
}
