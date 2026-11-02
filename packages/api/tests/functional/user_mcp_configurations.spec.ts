import UserMcpConfiguration from '#models/user_mcp_configuration'
import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

test.group('user MCP configurations', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('stores only the portable MCP configuration for the authenticated user', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const response = await client
      .put('/api/v1/account/mcp-configurations')
      .loginAs(user)
      .json({
        servers: [
          {
            disabled: false,
            name: 'Stripe',
            timeout: 45,
            transport: 'streamableHttp',
            url: 'https://mcp.stripe.com/',
          },
          { command: 'npx', disabled: true, name: 'Local', transport: 'stdio' },
        ],
      })

    response.assertStatus(200)
    const stored = await UserMcpConfiguration.findOrFail(user.id)
    assert.deepEqual(stored.servers, [
      {
        disabled: false,
        name: 'Stripe',
        timeout: 45,
        transport: 'streamableHttp',
        url: 'https://mcp.stripe.com/',
      },
      { command: 'npx', disabled: true, name: 'Local', transport: 'stdio' },
    ])
  })

  test('does not expose another user configuration', async ({ client, assert }) => {
    const owner = await createUser()
    const other = await createUser()
    await UserMcpConfiguration.create({
      userId: owner.id,
      servers: [{ disabled: false, name: 'Private', transport: 'stdio', command: 'node' }],
    })

    const response = await client.get('/api/v1/account/mcp-configurations').loginAs(other)

    response.assertStatus(200)
    assert.isNull(response.body().data)
  })

  test('never stores secret-bearing and non-portable fields', async ({ client, assert }) => {
    const user = await createUser()
    for (const server of [
      {
        disabled: false,
        headers: { Authorization: 'Bearer secret' },
        name: 'Headers',
        transport: 'streamableHttp',
        url: 'https://example.com',
      },
      {
        disabled: false,
        env: { API_TOKEN: 'secret' },
        name: 'Environment',
        transport: 'stdio',
        command: 'node',
      },
      {
        disabled: false,
        name: 'Query token',
        transport: 'sse',
        url: 'https://example.com/mcp?token=secret',
      },
      {
        args: ['--token', 'secret'],
        disabled: false,
        name: 'Arguments',
        transport: 'stdio',
        command: 'node',
      },
    ]) {
      const response = await client
        .put('/api/v1/account/mcp-configurations')
        .loginAs(user)
        .json({ servers: [server] })
      if (response.status() === 200) {
        const serialized = JSON.stringify(response.body())
        assert.notInclude(serialized, 'secret')
        assert.notInclude(serialized, 'Authorization')
        assert.notInclude(serialized, 'API_TOKEN')
      } else {
        response.assertStatus(422)
      }
    }
  })

  test('requires authentication', async ({ client }) => {
    const response = await client.get('/api/v1/account/mcp-configurations')
    response.assertStatus(401)
  })
})

function createUser() {
  return User.create({
    email: `${crypto.randomUUID()}@example.com`,
    password: 'password123',
  })
}
