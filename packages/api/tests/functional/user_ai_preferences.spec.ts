import UserAiPreference from '#models/user_ai_preference'
import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

type PreferenceBody = {
  data: {
    alternativeModel: {
      providerId: string
      modelId: string
      credentialLabel: string | null
      reasoningEffort: string | null
    }
    agentModel: {
      providerId: string
      modelId: string
      credentialLabel: string | null
      reasoningEffort: string | null
    }
  } | null
}

test.group('user ai preferences', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('returns null when preferences are missing', async ({ client, assert }) => {
    const user = await createUser()

    const response = await client.get('/api/v1/account/ai-preferences').loginAs(user)

    response.assertStatus(200)
    const body = response.body() as PreferenceBody
    assert.isNull(body.data)
  })

  test('saves and returns model preferences', async ({ client, assert }) => {
    const user = await createUser()

    const response = await client
      .put('/api/v1/account/ai-preferences')
      .loginAs(user)
      .json({
        alternativeModel: {
          providerId: 'google',
          modelId: 'gemini-2.5-flash',
          credentialLabel: null,
          reasoningEffort: 'low',
        },
        agentModel: {
          providerId: 'anthropic',
          modelId: 'claude-opus-4-1',
          credentialLabel: 'Work',
          reasoningEffort: 'high',
        },
      })

    response.assertStatus(200)
    const body = response.body() as PreferenceBody
    assert.equal(body.data?.alternativeModel.providerId, 'google')
    assert.equal(body.data?.agentModel.credentialLabel, 'Work')

    const stored = await UserAiPreference.findOrFail(user.id)
    assert.equal(stored.alternativeModelId, 'gemini-2.5-flash')
    assert.equal(stored.agentReasoningEffort, 'high')
  })

  test('requires authentication', async ({ client }) => {
    const response = await client.get('/api/v1/account/ai-preferences')

    response.assertStatus(401)
  })

  test('rejects invalid preference payloads', async ({ client }) => {
    const user = await createUser()

    const response = await client
      .put('/api/v1/account/ai-preferences')
      .loginAs(user)
      .json({
        alternativeModel: {
          providerId: 'google',
          modelId: 'gemini-2.5-flash',
          reasoningEffort: 'fast',
        },
        agentModel: {
          providerId: '',
          modelId: 'claude-opus-4-1',
          reasoningEffort: 'high',
        },
      })

    response.assertStatus(422)
  })
})

function createUser() {
  return User.create({
    email: `${crypto.randomUUID()}@example.com`,
    password: 'password123',
  })
}
