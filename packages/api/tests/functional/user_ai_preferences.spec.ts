import UserAiPreference from '#models/user_ai_preference'
import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'

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
    personalization: {
      responseStyle: string
      experience: string
      autonomy: string
      ambition: string
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

  test('returns the middle notch of every setting for a new preference', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    await savePreference(client, user)

    const response = await client.get('/api/v1/account/ai-preferences').loginAs(user)
    const body = response.body() as PreferenceBody

    assert.deepEqual(body.data?.personalization, {
      responseStyle: 'balanced',
      experience: 'comfortable',
      autonomy: 'balanced',
      ambition: 'standard',
    })
  })

  test('saves the personalization alone without touching the models', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    await savePreference(client, user)
    const personalization = {
      responseStyle: 'detailed',
      experience: 'new',
      autonomy: 'decide',
      ambition: 'ambitious',
    }

    const response = await client
      .put('/api/v1/account/ai-preferences')
      .loginAs(user)
      .json({ personalization })

    response.assertStatus(200)
    assert.deepEqual((response.body() as PreferenceBody).data?.personalization, personalization)
    const stored = await UserAiPreference.findOrFail(user.id)
    assert.equal(stored.responseStyle, 'detailed')
    assert.equal(stored.ambition, 'ambitious')
    assert.equal(stored.agentModelId, 'claude-opus-4-1')
  })

  test('keeps the personalization when only the models are saved', async ({ client, assert }) => {
    const user = await createUser()
    await savePreference(client, user)
    await client
      .put('/api/v1/account/ai-preferences')
      .loginAs(user)
      .json({
        personalization: {
          responseStyle: 'concise',
          experience: 'experienced',
          autonomy: 'ask',
          ambition: 'quick',
        },
      })

    await savePreference(client, user)

    const stored = await UserAiPreference.findOrFail(user.id)
    assert.equal(stored.responseStyle, 'concise')
    assert.equal(stored.autonomy, 'ask')
  })

  test('requires the models to create the preference', async ({ client }) => {
    const user = await createUser()

    const response = await client
      .put('/api/v1/account/ai-preferences')
      .loginAs(user)
      .json({
        personalization: {
          responseStyle: 'concise',
          experience: 'new',
          autonomy: 'ask',
          ambition: 'quick',
        },
      })

    response.assertStatus(422)
  })

  test('rejects values outside the notches', async ({ client }) => {
    const user = await createUser()
    await savePreference(client, user)

    const response = await client
      .put('/api/v1/account/ai-preferences')
      .loginAs(user)
      .json({
        personalization: {
          responseStyle: 'verbose',
          experience: 'new',
          autonomy: 'ask',
          ambition: 'quick',
        },
      })

    response.assertStatus(422)
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

function savePreference(client: ApiClient, user: User) {
  return client
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
}
function createUser() {
  return User.create({
    email: `${crypto.randomUUID()}@example.com`,
    password: 'password123',
  })
}
