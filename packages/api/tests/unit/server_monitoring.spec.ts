import { loadMonitoringConfig, otlpSignalEndpoint } from '#lib/monitoring/config'
import { monitoring } from '#lib/monitoring/metrics'
import { httpSpanName, sqlSpanName } from '#lib/monitoring/redacting_span_processor'
import {
  boundedErrorType,
  metricAttributes,
  sanitizeAttributes,
  sanitizeText,
  traceAttributes,
} from '#lib/monitoring/redaction'
import { initializeMonitoring, shutdownMonitoring } from '#lib/monitoring/sdk'
import { test } from '@japa/runner'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const options = { serviceName: 'blame-api-test', serviceVersion: '1.2.3' }

test.group('server monitoring', () => {
  test('stays off without a valid OTLP endpoint or when disabled', ({ assert }) => {
    assert.isFalse(loadMonitoringConfig({ ...options, environment: {} }).enabled)
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test' }
    assert.isTrue(loadMonitoringConfig({ ...options, environment: endpoint }).enabled)
    assert.isFalse(
      loadMonitoringConfig({
        ...options,
        environment: { ...endpoint, OTEL_SDK_DISABLED: 'true' },
      }).enabled
    )
    assert.isFalse(
      loadMonitoringConfig({
        ...options,
        environment: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test?authorization=secret' },
      }).enabled
    )
  })

  test('derives signal endpoints from the generic endpoint', ({ assert }) => {
    assert.equal(
      otlpSignalEndpoint('https://collector.test/otlp/', 'traces'),
      'https://collector.test/otlp/v1/traces'
    )
  })

  test('keeps only approved resource attributes', ({ assert }) => {
    const config = loadMonitoringConfig({
      ...options,
      environment: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test',
        OTEL_RESOURCE_ATTRIBUTES:
          'deployment.environment.name=staging,service.instance.id=node-1,user.id=private',
      },
    })
    assert.deepEqual(config.resourceAttributes, {
      'deployment.environment.name': 'staging',
      'service.instance.id': 'node-1',
    })
    assert.equal(config.deploymentEnvironment, 'staging')
  })

  test('redacts sensitive keys and values', ({ assert }) => {
    const attributes = sanitizeAttributes({
      'authorization': 'Bearer secret-token',
      'blame.runtime.phase': 'workspace.upload',
      'file_content': 'private source',
      'safe': 'token=secret-value',
    })
    assert.deepEqual(attributes, {
      'blame.runtime.phase': 'workspace.upload',
      'safe': '[REDACTED]',
    })
    assert.equal(sanitizeText('auth Bearer abcdefghijklmnop'), 'auth [REDACTED]')
    assert.equal(sanitizeText('ghp_abcdefghijklmnopqrstuvwxyz'), '[REDACTED]')
    assert.equal(sanitizeText('eyJheader.eyJpayload.signature'), '[REDACTED]')
    assert.equal(
      sanitizeText('https://user:password@example.test/path'),
      'https://[REDACTED]@example.test/path'
    )
  })

  test('removes private attributes from traces and logs', ({ assert }) => {
    assert.deepEqual(
      traceAttributes({
        'error.type': 'request failed with private data',
        'exception.message': 'Command failed: git status /private/repository',
        'http.request.method': 'GET',
        'server.address': 'api.example.test',
        'url.full': 'https://api.example.test?token=secret',
        'url.path': '/private/repository',
      }),
      { 'error.type': 'Error', 'http.request.method': 'GET', 'server.address': 'api.example.test' }
    )
  })

  test('keeps only bounded metric dimensions', ({ assert }) => {
    assert.deepEqual(
      metricAttributes({
        'blame.operation.status': 'failed',
        'blame.runtime.name': 'vercel-compose',
        'blame.runtime.phase': 'sandbox.create',
        'error.message': 'private failure',
        'user.id': 'user-1',
      }),
      {
        'blame.operation.status': 'failed',
        'blame.runtime.name': 'vercel-compose',
        'blame.runtime.phase': 'sandbox.create',
      }
    )
  })

  test('names automatic spans by method or SQL operation only', ({ assert }) => {
    assert.equal(boundedErrorType('ECONNREFUSED'), 'ECONNREFUSED')
    assert.equal(boundedErrorType('private message'), 'Error')
    assert.equal(sqlSpanName('select * from users where email = ?'), 'SELECT')
    assert.equal(sqlSpanName('private-query'), 'SQL')
    assert.equal(httpSpanName({ 'http.request.method': 'GET' }), 'GET')
    assert.equal(httpSpanName({ 'http.request.method': '/private/path' }), 'HTTP')
  })

  test('exports logs and metrics without sensitive attributes', async ({ assert }) => {
    const received = new Map<string, Buffer>()
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      received.set(request.url!, Buffer.concat(chunks))
      response.setHeader('content-type', 'application/x-protobuf')
      response.end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const { port } = server.address() as AddressInfo
      const config = initializeMonitoring({
        ...options,
        environment: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` },
      })
      assert.isTrue(config.enabled)
      const attributes = { 'blame.operation.status': 'succeeded', 'password': 'never-export-this' }
      monitoring.log('info', 'monitoring.test.log', attributes)
      monitoring.count('monitoring.test.counter', 1, attributes)
      await shutdownMonitoring()
      for (const [signal, name] of [
        ['logs', 'monitoring.test.log'],
        ['metrics', 'monitoring.test.counter'],
      ]) {
        const payload = received.get(`/v1/${signal}`)
        assert.isTrue(Boolean(payload?.length), `missing ${signal} export`)
        assert.isTrue(payload!.includes(name))
        assert.isFalse(payload!.includes('never-export-this'))
      }
    } finally {
      await shutdownMonitoring()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
