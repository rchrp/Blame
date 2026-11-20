import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

type RecommendationsBody = {
  data: {
    all: Array<{ providerId: string; modelId: string; segment: string }>
    byProvider: Record<string, Array<{ modelId: string }>>
  }
}

// The API ranks the models the engine offers: it keeps no catalog of its
// own. Benchmarks are off in tests (`BLAME_MODEL_BENCHMARKS=false`), so
// every model is ranked as unbenchmarked: recent ones only.
test.group('model recommendations', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('ranks the models a client sends, by provider', async ({ client, assert }) => {
    const user = await createUser()
    const today = new Date().toISOString().slice(0, 10)
    const response = await client
      .post('/api/v1/providers/recommendations')
      .loginAs(user)
      .json({
        connected: ['anthropic'],
        models: [
          {
            providerId: 'anthropic',
            modelId: 'claude-brand-new-1',
            name: 'Claude Brand New 1',
            releaseDate: today,
            cost: { input: 3, output: 15, cacheRead: 0.3 },
          },
          {
            providerId: 'anthropic',
            modelId: 'claude-old',
            name: 'Claude Old',
            releaseDate: '2020-01-01',
            cost: { input: 3, output: 15 },
          },
        ],
      })
    response.assertStatus(200)
    const body = response.body() as RecommendationsBody
    assert.deepEqual(
      body.data.byProvider.anthropic.map((entry) => entry.modelId),
      ['claude-brand-new-1']
    )
    assert.equal(body.data.all[0]?.segment, 'unbenchmarked')
  })

  test('refuses providers the engine does not serve', async ({ client }) => {
    const user = await createUser()
    const response = await client
      .post('/api/v1/providers/recommendations')
      .loginAs(user)
      .json({ connected: ['bedrock'], models: [] } as never)
    response.assertStatus(422)
  })
})

async function createUser() {
  return User.create({
    email: `${crypto.randomUUID()}@example.com`,
    password: 'password123',
  })
}
