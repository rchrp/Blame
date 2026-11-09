import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { MySQL2Instrumentation } from '@opentelemetry/instrumentation-mysql2'
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino'
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import {
  PeriodicExportingMetricReader,
  createAllowListAttributesProcessor,
  type ViewOptions,
} from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import {
  loadMonitoringConfig,
  otlpSignalEndpoint,
  type MonitoringConfig,
  type MonitoringOptions,
} from '#lib/monitoring/config'
import { monitoringScope } from '#lib/monitoring/metrics'
import { metricAttributeKeys } from '#lib/monitoring/redaction'
import { RedactingSpanProcessor } from '#lib/monitoring/redacting_span_processor'

let activeConfig: MonitoringConfig | undefined
let nodeSdk: NodeSDK | undefined
let shutdownPromise: Promise<void> | undefined

// Starts before AdonisJS loads, so the HTTP and MySQL instrumentations patch
// those modules first. One SDK per process.
export function initializeMonitoring(options: MonitoringOptions): MonitoringConfig {
  if (activeConfig) return activeConfig
  activeConfig = loadMonitoringConfig(options)
  if (!activeConfig.enabled) return activeConfig
  try {
    nodeSdk = createNodeSdk(activeConfig, activeConfig.endpoint!)
    nodeSdk.start()
  } catch {
    nodeSdk = undefined
    activeConfig = { ...activeConfig, enabled: false }
    writeMonitoringWarning('blame.monitoring.initialization_failed')
  }
  return activeConfig
}

export function shutdownMonitoring(timeoutMs = 3_000) {
  shutdownPromise ??= shutdownSdk(timeoutMs)
  return shutdownPromise
}

function createNodeSdk(config: MonitoringConfig, endpoint: string) {
  return new NodeSDK({
    autoDetectResources: false,
    instrumentations: [
      new HttpInstrumentation({ redactedQueryParams: sensitiveQueryParameters }),
      new UndiciInstrumentation({ requireParentforSpans: true }),
      new RuntimeNodeInstrumentation({ monitoringPrecision: 60_000 }),
      new MySQL2Instrumentation({ maskStatement: true, maskStatementHook: () => '[REDACTED]' }),
      new PinoInstrumentation({
        disableLogSending: true,
        logKeys: { spanId: 'span_id', traceFlags: 'trace_flags', traceId: 'trace_id' },
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: otlpSignalEndpoint(endpoint, 'logs') }),
      }),
    ],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: otlpSignalEndpoint(endpoint, 'metrics') }),
        exportIntervalMillis: config.exportIntervalMs,
      }),
    ],
    resource: resourceFromAttributes({
      ...config.resourceAttributes,
      'deployment.environment.name': config.deploymentEnvironment,
      'host.arch': process.arch,
      'os.type': process.platform,
      'process.runtime.name': 'nodejs',
      'process.runtime.version': process.versions.node,
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: config.serviceVersion,
    }),
    spanProcessors: [
      new RedactingSpanProcessor(),
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({ url: otlpSignalEndpoint(endpoint, 'traces') }),
      }),
    ],
    views: [
      metricView(monitoringScope, metricAttributeKeys),
      metricView('@opentelemetry/instrumentation-http', httpMetricKeys),
      metricView('@opentelemetry/instrumentation-undici', httpMetricKeys),
    ],
  })
}

function metricView(meterName: string, attributeKeys: string[]): ViewOptions {
  return {
    aggregationCardinalityLimit: 200,
    attributesProcessors: [createAllowListAttributesProcessor(attributeKeys)],
    instrumentName: '*',
    meterName,
  }
}

async function shutdownSdk(timeoutMs: number) {
  if (!nodeSdk) return
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
    timer.unref()
  })
  try {
    await Promise.race([nodeSdk.shutdown(), timeout])
  } catch {
    writeMonitoringWarning('blame.monitoring.shutdown_failed')
  } finally {
    clearTimeout(timer)
  }
}

function writeMonitoringWarning(eventName: string) {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      severity_text: 'WARN',
      event_name: eventName,
    })
  )
}

const sensitiveQueryParameters = [
  'AWSAccessKeyId',
  'Signature',
  'X-Goog-Signature',
  'access_token',
  'api_key',
  'authorization',
  'code',
  'credential',
  'key',
  'password',
  'refresh_token',
  'secret',
  'sig',
  'token',
]

const httpMetricKeys = [
  'http.method',
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'http.status_code',
  'network.protocol.version',
  'server.address',
  'server.port',
  'url.scheme',
]
