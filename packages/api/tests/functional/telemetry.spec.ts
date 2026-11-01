import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

type TelemetrySession = {
  endpoint: string
  expiresAt: string
  token: string
}

test.group('telemetry', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('requires an authenticated account for telemetry sessions', async ({ client }) => {
    const response = await client.get('/api/v1/telemetry/session')
    response.assertStatus(401)
  })

  test('issues a session and forwards authenticated OTLP protobuf', async ({ client, assert }) => {
    const user = await createUser()
    const sessionResponse = await client.get('/api/v1/telemetry/session').loginAs(user)
    sessionResponse.assertStatus(200)
    sessionResponse.assertHeader('cache-control', 'private, no-store')
    const session = responseData(sessionResponse.body())
    let forwardedPayload = Buffer.alloc(0)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_input, init) => {
      forwardedPayload = Buffer.from(init?.body as Uint8Array)
      return new Response(new Uint8Array(), {
        headers: { 'content-type': 'application/x-protobuf' },
        status: 200,
      })
    }
    try {
      const payload = Buffer.from([10, 0])
      const response = await client
        .post('/api/v1/telemetry/otlp/v1/traces')
        .header('Authorization', `Bearer ${session.token}`)
        .header('Content-Type', 'application/x-protobuf')
        .setup((request) => request.request.send(payload))
      response.assertStatus(200)
      assert.deepEqual(forwardedPayload, payload)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects invalid ingestion tokens before forwarding', async ({ client }) => {
    const response = await client
      .post('/api/v1/telemetry/otlp/v1/metrics')
      .header('Authorization', 'Bearer invalid')
      .header('Content-Type', 'application/x-protobuf')
      .setup((request) => request.request.send(Buffer.from([10, 0])))
    response.assertStatus(401)
  })
})

function responseData(body: unknown): TelemetrySession {
  if (!body || typeof body !== 'object') throw new Error('Missing telemetry session')
  const value = 'data' in body ? body.data : body
  return value as TelemetrySession
}

function createUser() {
  return User.create({
    email: `${crypto.randomUUID()}@example.com`,
    password: 'password123',
  })
}
