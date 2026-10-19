import ModelCatalogSnapshot from '#models/model_catalog_snapshot'
import User from '#models/user'
import ProviderCredentialsService from '#services/provider_credentials_service'
import { createLicensedUser } from '#tests/helpers/create_licensed_user'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { getModelsForProvider, type ModelInfo } from '@cline/llms'

test.group('model catalog', (group) => {
  group.setup(async () => {
    await testUtils.db().migrate()
  })
  group.each.setup(() => testUtils.db().truncate())

  test('returns a protected backend catalog for connected providers', async ({
    client,
    assert,
  }) => {
    const user = await createLicensedUser()
    await new ProviderCredentialsService().save(user.id, {
      providerId: 'anthropic',
      label: 'Work',
      apiKey: 'sk-never-return-this',
    })

    const response = await client.get('/api/v1/providers/catalog').loginAs(user)

    response.assertStatus(200)
    const body = (response.body() as unknown as { data: CatalogResponse }).data
    assert.isArray(body.all)
    assert.property(body.default, 'anthropic')
    assert.property(body.recommendations.byProvider, 'anthropic')
    assert.notInclude(JSON.stringify(body), 'sk-never-return-this')
    assert.notInclude(JSON.stringify(body), 'encryptedApiKey')
    assert.isNotNull(await ModelCatalogSnapshot.find('global'))
  })

  test('serves complete metadata for one catalog model', async ({ client, assert }) => {
    const user = await createLicensedUser()
    const models: Record<string, ModelInfo> = await getModelsForProvider('anthropic')
    const [modelId, expected] = Object.entries(models)[0]

    const response = await client
      .get('/api/v1/providers/catalog/model')
      .qs({ providerId: 'anthropic', modelId })
      .loginAs(user)

    response.assertStatus(200)
    const body = response.body() as unknown as { data: { contextWindow?: number } }
    assert.equal(body.data.contextWindow, expected.contextWindow)
  })

  test('rejects unknown or incomplete model lookups', async ({ client }) => {
    const user = await createLicensedUser()

    const unknown = await client
      .get('/api/v1/providers/catalog/model')
      .qs({ providerId: 'anthropic', modelId: 'not-a-real-model' })
      .loginAs(user)
    unknown.assertStatus(404)

    const incomplete = await client
      .get('/api/v1/providers/catalog/model')
      .qs({ providerId: 'anthropic' })
      .loginAs(user)
    incomplete.assertStatus(400)
  })

  test('allows the model catalog without a Blame subscription', async ({ client }) => {
    const user = await User.create({
      email: `${crypto.randomUUID()}@example.com`,
      password: 'password123',
    })

    const response = await client.get('/api/v1/providers/catalog').loginAs(user)

    response.assertStatus(200)
  })
})

type CatalogResponse = {
  all: unknown[]
  default: Record<string, string>
  recommendations: {
    byProvider: Record<string, unknown[]>
  }
}
