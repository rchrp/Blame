import CredentialEncryptionRotationService from '#services/credential_encryption_rotation_service'
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

  test('keeps the secrets of a server only when the person chose to, encrypted', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const server = {
      command: 'npx',
      disabled: false,
      name: 'Dokploy',
      transport: 'stdio',
    }
    const response = await client
      .put('/api/v1/account/mcp-configurations')
      .loginAs(user)
      .json({
        servers: [
          {
            ...server,
            secrets: { args: ['-y', '@dokploy/mcp'], env: { DOKPLOY_TOKEN: 'fake-token' } },
          },
          { ...server, name: 'Plain', localParts: { args: true, env: ['PLAIN_TOKEN'] } },
        ],
      })
    response.assertStatus(200)
    const stored = await UserMcpConfiguration.findOrFail(user.id)
    // Not in the readable column, not in clear text in the encrypted one.
    assert.notInclude(JSON.stringify(stored.servers), 'fake-token')
    assert.exists(stored.encryptedSecrets)
    assert.notInclude(stored.encryptedSecrets!, 'fake-token')
    assert.deepEqual(stored.servers[1].localParts, { args: true, env: ['PLAIN_TOKEN'] })

    const read = await client.get('/api/v1/account/mcp-configurations').loginAs(user)
    const servers = read.body().data!.servers
    assert.deepEqual(servers[0].secrets, {
      args: ['-y', '@dokploy/mcp'],
      env: { DOKPLOY_TOKEN: 'fake-token' },
    })
    assert.isTrue(servers[0].secretsSynced)
    assert.isUndefined(servers[1].secrets)
  })

  test('an older app saving the list does not drop the secrets, an explicit opt-out does', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const server = { command: 'npx', disabled: false, name: 'Dokploy', transport: 'stdio' }
    await client
      .put('/api/v1/account/mcp-configurations')
      .loginAs(user)
      .json({ servers: [{ ...server, secrets: { env: { DOKPLOY_TOKEN: 'fake-token' } } }] })

    // An app that knows nothing of secrets sends the plain list back.
    await client
      .put('/api/v1/account/mcp-configurations')
      .loginAs(user)
      .json({ servers: [{ ...server, disabled: true }] })
    let read = await client.get('/api/v1/account/mcp-configurations').loginAs(user)
    assert.equal(read.body().data!.servers[0].secrets?.env?.DOKPLOY_TOKEN, 'fake-token')

    await client
      .put('/api/v1/account/mcp-configurations')
      .loginAs(user)
      .json({ servers: [{ ...server, secretsSynced: false }] })
    read = await client.get('/api/v1/account/mcp-configurations').loginAs(user)
    assert.isUndefined(read.body().data!.servers[0].secrets)
    assert.isNull((await UserMcpConfiguration.findOrFail(user.id)).encryptedSecrets)
  })

  test('a removed server takes its secrets with it', async ({ client, assert }) => {
    const user = await createUser()
    await client
      .put('/api/v1/account/mcp-configurations')
      .loginAs(user)
      .json({
        servers: [
          {
            command: 'npx',
            disabled: false,
            name: 'Dokploy',
            transport: 'stdio',
            secrets: { env: { DOKPLOY_TOKEN: 'fake-token' } },
          },
        ],
      })
    await client.put('/api/v1/account/mcp-configurations').loginAs(user).json({ servers: [] })
    assert.isNull((await UserMcpConfiguration.findOrFail(user.id)).encryptedSecrets)
  })

  test('refuses secrets that do not fit the kind of server', async ({ client }) => {
    const user = await createUser()
    const response = await client
      .put('/api/v1/account/mcp-configurations')
      .loginAs(user)
      .json({
        servers: [
          {
            disabled: false,
            name: 'Remote',
            transport: 'streamableHttp',
            url: 'https://example.com/mcp',
            secrets: { env: { A: 'b' } },
          },
        ],
      })
    response.assertStatus(422)
  })

  test('the key rotation re-encrypts the synced secrets and keeps them readable', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    await client
      .put('/api/v1/account/mcp-configurations')
      .loginAs(user)
      .json({
        servers: [
          {
            command: 'npx',
            disabled: false,
            name: 'Dokploy',
            transport: 'stdio',
            secrets: { env: { DOKPLOY_TOKEN: 'fake-token' } },
          },
        ],
      })
    const before = (await UserMcpConfiguration.findOrFail(user.id)).encryptedSecrets
    await new CredentialEncryptionRotationService().rotate()
    await new CredentialEncryptionRotationService().verify()
    const after = (await UserMcpConfiguration.findOrFail(user.id)).encryptedSecrets
    assert.notEqual(after, before)
    const read = await client.get('/api/v1/account/mcp-configurations').loginAs(user)
    assert.equal(read.body().data!.servers[0].secrets?.env?.DOKPLOY_TOKEN, 'fake-token')
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
