import PreviewComponentPreviewService, {
  componentPreviewRouteId,
} from '#services/preview_sessions/preview_component_preview_service'
import { opaqueRouteId } from '#services/preview_gateway/preview_edge_route_service'
import {
  componentPreviewSandbox,
  PreviewRuntimeError,
  type RuntimeHandle,
} from '@blame/preview-runtime'
import { test } from '@japa/runner'

const sessionId = 'preview_0123456789abcdef0123456789abcdef'
const providerUrl = 'https://sb-43900-abc.vercel.run'
const start = { nodeArguments: ['--input-type=module', '-e', 'server'], port: 51_234 }

// A cloud preview whose sandbox was created before the component preview
// port was reserved, with an injected driver, lock and capability signer.
function harness(state = { host: 'running', preview: 'ready' }, owner = 'user-1') {
  const handle = {
    kind: 'vercel-sandbox',
    sandboxName: 'blame-x',
    sessionId,
    generation: 3,
    fencingToken: 1,
    gatewayPorts: [43_000],
  } as unknown as RuntimeHandle & { gatewayPorts: number[] }
  const calls: Array<[string, unknown]> = []
  const saved: Array<{ fencingToken?: number; gatewayPorts: number[] }> = []
  const service = new PreviewComponentPreviewService({
    capabilities: {
      issue: (route, ttlSeconds) => {
        calls.push(['issue', { route, ttlSeconds }])
        return { token: `capability-${calls.length}`, expiresAt: 2_000_000_000 }
      },
    },
    driver: {
      startComponentPreview: async (runtime, input) => {
        calls.push(['start', input])
        ;(runtime as typeof handle).gatewayPorts.push(componentPreviewSandbox.gatewayPort)
        return { generation: 3, providerUrl, sessionId }
      },
      componentPreviewRoute: async () => ({ generation: 3, providerUrl, sessionId }),
      componentPreviewOutput: async (_runtime, cursor) => ({
        cursor: { stderr: cursor.stderr, stdout: cursor.stdout + 7 },
        running: true,
        stderr: '',
        stdout: 'started',
      }),
      stopComponentPreview: async (runtime) => {
        calls.push(['stop', runtime.fencingToken])
        return { stopped: true }
      },
    },
    lease: {
      renew: async (id) => {
        calls.push(['lease', id])
        return ''
      },
    },
    lock: { withLock: (_key, operation) => operation({ fencingToken: 9 } as never) },
    repository: {
      get: async () => ({ ownerUserId: owner, state }) as never,
      getRuntimeHandle: async () => handle,
      setRuntimeHandle: async (_id, value) => {
        const saving = value as typeof handle
        saved.push({ fencingToken: saving.fencingToken, gatewayPorts: [...saving.gatewayPorts] })
      },
    },
  })
  return { calls, saved, service }
}

test.group('Component preview of a cloud preview', () => {
  test('starts the server in the sandbox and grants its own capability route', async ({
    assert,
  }) => {
    const { calls, saved, service } = harness()
    const grant = await service.start('user-1', sessionId, start)
    const routeId = opaqueRouteId(
      sessionId,
      componentPreviewSandbox.serviceId,
      componentPreviewSandbox.endpointId
    )
    assert.equal(componentPreviewRouteId(sessionId), routeId)
    assert.deepEqual(calls[0], ['start', { ...start, routeId }])
    assert.deepEqual(grant, {
      sessionId,
      endpointRevision: 0,
      integratedPreviewRequired: false,
      primaryRouteId: routeId,
      routes: [
        {
          routeId,
          serviceId: componentPreviewSandbox.serviceId,
          endpointId: componentPreviewSandbox.endpointId,
          logicalHost: 'localhost',
          logicalPort: 51_234,
          protocol: 'http',
          providerUrl,
          capability: 'capability-3',
          capabilityExpiresAt: new Date(2_000_000_000_000).toISOString(),
        },
      ],
    })
    assert.deepEqual(calls[2], [
      'issue',
      {
        route: {
          sessionId,
          routeId,
          serviceId: componentPreviewSandbox.serviceId,
          endpointId: componentPreviewSandbox.endpointId,
          generation: 3,
        },
        ttlSeconds: 60,
      },
    ])
    // Fenced before the runner call, saved again with the reserved port.
    assert.deepEqual(saved, [
      { fencingToken: 9, gatewayPorts: [43_000] },
      { fencingToken: 9, gatewayPorts: [43_000, componentPreviewSandbox.gatewayPort] },
    ])
    assert.deepEqual(calls[1], ['lease', sessionId])
  })

  test('refreshes the capability, reads output and stops', async ({ assert }) => {
    const { calls, service } = harness()
    const refreshed = await service.refresh('user-1', sessionId, 51_234)
    assert.equal(refreshed.routes[0]!.providerUrl, providerUrl)
    assert.equal(refreshed.routes[0]!.logicalPort, 51_234)
    assert.deepEqual(calls[0], ['lease', sessionId])
    assert.deepEqual(await service.output('user-1', sessionId, { stderr: 0, stdout: 5 }), {
      cursor: { stderr: 0, stdout: 12 },
      running: true,
      stderr: '',
      stdout: 'started',
    })
    assert.deepEqual(await service.stop('user-1', sessionId), { stopped: true })
    assert.deepEqual(calls.at(-1), ['stop', 9])
  })

  test('refuses another owner and a preview that is not ready', async ({ assert }) => {
    const other = harness(undefined, 'user-2')
    await assert.rejects(
      () => other.service.start('user-1', sessionId, start),
      'This preview is unavailable.'
    )
    const stopped = harness({ host: 'suspended', preview: 'closed' })
    try {
      await stopped.service.start('user-1', sessionId, start)
      assert.fail('The start should be refused.')
    } catch (error) {
      assert.instanceOf(error, PreviewRuntimeError)
      assert.equal((error as PreviewRuntimeError).failure.code, 'ENDPOINT_NOT_LISTENING')
    }
    assert.deepEqual([...other.calls, ...stopped.calls], [])
  })
})
