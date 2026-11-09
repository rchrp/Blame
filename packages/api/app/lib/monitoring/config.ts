// The API monitors itself only when its operator points it at an OTLP
// collector with OTEL_EXPORTER_OTLP_ENDPOINT; OTEL_SDK_DISABLED=true turns it off.

export type MonitoringConfig = {
  deploymentEnvironment: string
  enabled: boolean
  endpoint?: string
  exportIntervalMs: number
  resourceAttributes: Record<string, string>
  serviceName: string
  serviceVersion: string
}

export type MonitoringOptions = {
  environment?: NodeJS.ProcessEnv
  serviceName: string
  serviceVersion: string
}

export type MonitoringSignal = 'logs' | 'metrics' | 'traces'

const defaultExportIntervalMs = 60_000
const deploymentEnvironmentAttribute = 'deployment.environment.name'
const allowedResourceAttributes = new Set([
  deploymentEnvironmentAttribute,
  'cloud.region',
  'host.arch',
  'service.instance.id',
  'service.namespace',
])

export function loadMonitoringConfig(options: MonitoringOptions): MonitoringConfig {
  const environment = options.environment ?? process.env
  const endpoint = validEndpoint(environment.OTEL_EXPORTER_OTLP_ENDPOINT)
  const disabled = environment.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true'
  const resource = resourceAttributes(environment)
  return {
    deploymentEnvironment:
      resource[deploymentEnvironmentAttribute] ?? environment.NODE_ENV?.trim() ?? 'development',
    enabled: Boolean(endpoint) && !disabled,
    endpoint,
    exportIntervalMs: positiveInteger(
      environment.OTEL_METRIC_EXPORT_INTERVAL,
      defaultExportIntervalMs
    ),
    resourceAttributes: resource,
    serviceName: options.serviceName,
    serviceVersion: options.serviceVersion,
  }
}

// The generic endpoint is the only source of the three signal URLs.
export function otlpSignalEndpoint(endpoint: string, signal: MonitoringSignal) {
  const url = new URL(endpoint)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/${signal}`
  return url.toString()
}

function resourceAttributes(environment: NodeJS.ProcessEnv) {
  const entries = (environment.OTEL_RESOURCE_ATTRIBUTES ?? '')
    .split(',')
    .flatMap(parseResourceAttribute)
  return Object.fromEntries(entries.filter(([key]) => allowedResourceAttributes.has(key)))
}

function parseResourceAttribute(value: string): Array<[string, string]> {
  const separator = value.indexOf('=')
  if (separator < 1) return []
  const key = value.slice(0, separator).trim()
  const attributeValue = decodeResourceValue(value.slice(separator + 1).trim())
  return key && attributeValue ? [[key, attributeValue]] : []
}

function decodeResourceValue(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function validEndpoint(value: string | undefined) {
  const endpoint = value?.trim()
  if (!endpoint) return undefined
  try {
    const url = new URL(endpoint)
    if (url.username || url.password || url.search || url.hash) return undefined
    return url.protocol === 'http:' || url.protocol === 'https:' ? endpoint : undefined
  } catch {
    return undefined
  }
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
