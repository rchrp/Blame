import { metrics, type Counter, type Histogram, type MetricOptions } from '@opentelemetry/api'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { metricAttributes, traceAttributes } from '#lib/monitoring/redaction'

export const monitoringScope = '@blame/api'

export type MonitoringSeverity = 'info' | 'warn' | 'error'

const runtimeDurationBucketBoundaries = [
  0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 900, 1_200, 1_800, 2_400,
]
const instrumentOptions = new Map<string, MetricOptions>([
  ['blame.runtime.phase.count', { unit: '{phase}' }],
  [
    'blame.runtime.phase.duration',
    { advice: { explicitBucketBoundaries: runtimeDurationBucketBoundaries }, unit: 's' },
  ],
])

// Counters, histograms and logs about the API itself. Until the SDK starts,
// and whenever monitoring is off, they go to OpenTelemetry's no-op providers.
class ServerMonitoring {
  private readonly counters = new Map<string, Counter>()
  private readonly histograms = new Map<string, Histogram>()

  count(name: string, value = 1, attributes: Record<string, unknown> = {}) {
    this.counter(name).add(value, metricAttributes(attributes))
  }

  record(name: string, value: number, attributes: Record<string, unknown> = {}) {
    if (Number.isFinite(value)) this.histogram(name).record(value, metricAttributes(attributes))
  }

  log(severity: MonitoringSeverity, eventName: string, attributes: Record<string, unknown> = {}) {
    logs.getLogger(monitoringScope).emit({
      attributes: traceAttributes(attributes),
      body: eventName,
      eventName,
      severityNumber: severityNumber(severity),
      severityText: severity.toUpperCase(),
    })
  }

  private counter(name: string) {
    let counter = this.counters.get(name)
    if (!counter) {
      counter = metrics.getMeter(monitoringScope).createCounter(name, instrumentOptions.get(name))
      this.counters.set(name, counter)
    }
    return counter
  }

  private histogram(name: string) {
    let histogram = this.histograms.get(name)
    if (!histogram) {
      histogram = metrics
        .getMeter(monitoringScope)
        .createHistogram(name, instrumentOptions.get(name))
      this.histograms.set(name, histogram)
    }
    return histogram
  }
}

export const monitoring = new ServerMonitoring()

function severityNumber(severity: MonitoringSeverity) {
  if (severity === 'warn') return SeverityNumber.WARN
  if (severity === 'error') return SeverityNumber.ERROR
  return SeverityNumber.INFO
}
