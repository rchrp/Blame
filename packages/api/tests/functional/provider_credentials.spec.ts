import ProviderCredential from '#models/provider_credential'
import CredentialEncryptionRotationService from '#services/credential_encryption_rotation_service'
import ProviderCredentialsService from '#services/provider_credentials_service'
import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

type CredentialBody = {
  data: {
    id: string
    providerId: string
    label: string
    baseUrl: string | null
    modelIds: string[]
    apiKey?: string
  }
}

type CredentialListBody = {
  data: CredentialBody['data'][]
}

test.group('provider credentials', (group) => {
  group.setup(() => testUtils.db().migrate())
  group.each.setup(() => testUtils.db().truncate())

  test('stores encrypted credentials and hides secrets from list responses', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const apiKey = 'sk-test-provider-key'

    const createResponse = await client.post('/api/v1/providers/credentials').loginAs(user).json({
      providerId: 'anthropic',
      apiKey,
    })

    createResponse.assertStatus(200)
    const created = createResponse.body() as CredentialBody
    assert.equal(created.data.providerId, 'anthropic')
    assert.isUndefined(created.data.apiKey)

    const stored = await ProviderCredential.findOrFail(created.data.id)
    assert.notEqual(stored.encryptedApiKey, apiKey)
    assert.notInclude(stored.encryptedApiKey, apiKey)

    const listResponse = await client.get('/api/v1/providers/credentials').loginAs(user)
    listResponse.assertStatus(200)
    const list = listResponse.body() as unknown as CredentialListBody
    assert.lengthOf(list.data, 1)
    assert.isUndefined(list.data[0].apiKey)
  })

  test('resolves credentials for the owner only and deletes them', async ({ client, assert }) => {
    const owner = await createUser()
    const other = await createUser()

    const createResponse = await client.post('/api/v1/providers/credentials').loginAs(owner).json({
      providerId: 'openai',
      apiKey: 'sk-owner-key',
    })

    const created = createResponse.body() as CredentialBody

    const forbiddenResolve = await client
      .post('/api/v1/providers/credentials/resolve')
      .loginAs(other)
      .json({ providerId: 'openai' })

    forbiddenResolve.assertStatus(404)

    const resolveResponse = await client
      .post('/api/v1/providers/credentials/resolve')
      .loginAs(owner)
      .json({ providerId: 'openai' })

    resolveResponse.assertStatus(200)
    const resolved = resolveResponse.body() as unknown as CredentialBody
    assert.equal(resolved.data.apiKey, 'sk-owner-key')

    const deleteResponse = await client
      .delete(`/api/v1/providers/credentials/${created.data.id}`)
      .loginAs(owner)

    deleteResponse.assertStatus(204)

    const listResponse = await client.get('/api/v1/providers/credentials').loginAs(owner)
    const list = listResponse.body() as unknown as CredentialListBody
    assert.lengthOf(list.data, 0)
  })

  test('stores multiple labeled credentials for the same provider', async ({ client, assert }) => {
    const user = await createUser()

    await client
      .post('/api/v1/providers/credentials')
      .loginAs(user)
      .json({ providerId: 'anthropic', label: 'Work', apiKey: 'sk-work' })

    await client
      .post('/api/v1/providers/credentials')
      .loginAs(user)
      .json({ providerId: 'anthropic', label: 'Personal', apiKey: 'sk-personal' })

    await client
      .post('/api/v1/providers/credentials')
      .loginAs(user)
      .json({ providerId: 'anthropic', label: 'Work', apiKey: 'sk-work-updated' })

    const listResponse = await client.get('/api/v1/providers/credentials').loginAs(user)
    listResponse.assertStatus(200)
    const list = listResponse.body() as unknown as CredentialListBody
    assert.lengthOf(list.data, 2)

    const resolveResponse = await client
      .post('/api/v1/providers/credentials/resolve')
      .loginAs(user)
      .json({ providerId: 'anthropic', label: 'Work' })

    resolveResponse.assertStatus(200)
    const resolved = resolveResponse.body() as unknown as CredentialBody
    assert.equal(resolved.data.apiKey, 'sk-work-updated')
  })

  test('stores openai-compatible model ids', async ({ client, assert }) => {
    const user = await createUser()

    const createResponse = await client
      .post('/api/v1/providers/credentials')
      .loginAs(user)
      .json({
        providerId: 'openai-compatible',
        label: 'Qwen',
        apiKey: 'sk-qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        modelIds: ['qwen3.7-plus', 'qwen3-coder-plus', 'qwen3.7-plus'],
      })

    createResponse.assertStatus(200)
    const created = createResponse.body() as CredentialBody
    assert.deepEqual(created.data.modelIds, ['qwen3.7-plus', 'qwen3-coder-plus'])

    const listResponse = await client.get('/api/v1/providers/credentials').loginAs(user)
    listResponse.assertStatus(200)
    const list = listResponse.body() as unknown as CredentialListBody
    assert.deepEqual(list.data[0].modelIds, ['qwen3.7-plus', 'qwen3-coder-plus'])
  })

  test('re-encrypts API keys and OAuth credentials atomically', async ({ assert }) => {
    const user = await createUser()
    const credentials = new ProviderCredentialsService()
    const stored = await credentials.saveOAuth(user.id, {
      providerId: 'anthropic',
      label: 'Work',
      apiKey: 'sk-oauth-provider-key',
      oauthCredentials: {
        access: 'oauth-access-token',
        refresh: 'oauth-refresh-token',
        expires: Date.now() + 60_000,
      },
    })
    const previousApiKeyCiphertext = stored.encryptedApiKey
    const previousOauthCiphertext = stored.encryptedOauthCredentials

    const rotation = new CredentialEncryptionRotationService()
    const rotated = await rotation.rotate()
    const verified = await rotation.verify()
    await stored.refresh()
    const resolved = await credentials.resolve(user.id, {
      providerId: 'anthropic',
      label: 'Work',
    })

    assert.equal(rotated, 1)
    assert.equal(verified, 1)
    assert.notEqual(stored.encryptedApiKey, previousApiKeyCiphertext)
    assert.notEqual(stored.encryptedOauthCredentials, previousOauthCiphertext)
    assert.equal(resolved.apiKey, 'sk-oauth-provider-key')
    assert.equal(resolved.oauthCredentials?.access, 'oauth-access-token')
    assert.equal(resolved.oauthCredentials?.refresh, 'oauth-refresh-token')
  })

  test('stores a local CLI connection without a secret', async ({ client, assert }) => {
    const user = await createUser()

    const createResponse = await client
      .post('/api/v1/providers/credentials/local')
      .loginAs(user)
      .json({ providerId: 'claude-code', accountId: 'dev@example.com' })

    createResponse.assertStatus(200)
    const created = createResponse.body() as {
      data: CredentialBody['data'] & { authMethod: string; accountId: string | null }
    }
    assert.equal(created.data.authMethod, 'local-cli')
    assert.equal(created.data.accountId, 'dev@example.com')
    assert.equal(created.data.label, 'default')

    const resolveResponse = await client
      .post('/api/v1/providers/credentials/resolve')
      .loginAs(user)
      .json({ providerId: 'claude-code' })

    resolveResponse.assertStatus(200)
    const resolved = resolveResponse.body() as unknown as {
      data: CredentialBody['data'] & { authMethod: string }
    }
    assert.equal(resolved.data.authMethod, 'local-cli')
    assert.equal(resolved.data.apiKey, '')

    const rejected = await client
      .post('/api/v1/providers/credentials/local')
      .loginAs(user)
      .json({ providerId: 'anthropic' })

    rejected.assertStatus(422)
  })
})

function createUser() {
  return User.create({
    email: `${crypto.randomUUID()}@example.com`,
    password: 'password123',
  })
}
