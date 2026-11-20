import Migration from '#database/migrations/1785000000000_use_engine_provider_ids'
import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'

// The data step of the migration that names providers by the engine's ids,
// run again on rows written with the app's old ids.
test.group('engine provider ids migration', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('renames the engine providers and removes the others', async ({ assert }) => {
    const user = await User.create({
      email: `${crypto.randomUUID()}@example.com`,
      password: 'password123',
    })
    const other = await User.create({
      email: `${crypto.randomUUID()}@example.com`,
      password: 'password123',
    })
    const now = new Date()
    const credential = (providerId: string, label = 'default') => ({
      id: crypto.randomUUID(),
      user_id: user.id,
      provider_id: providerId,
      label,
      encrypted_api_key: 'encrypted',
      auth_method: 'api-key',
      created_at: now,
    })
    await db.table('provider_credentials').multiInsert([
      credential('openai-native'),
      credential('openai-codex'),
      credential('anthropic'),
      credential('openai-compatible'),
      // Cline's own OpenAI-compatible provider, and providers the engine
      // does not serve.
      credential('openai'),
      credential('cline'),
      credential('bedrock'),
    ])
    const preference = (userId: string, agent: string, alternative: string) => ({
      user_id: userId,
      agent_provider_id: agent,
      agent_model_id: 'model',
      alternative_provider_id: alternative,
      alternative_model_id: 'model',
      response_style: 'balanced',
      experience: 'comfortable',
      autonomy: 'balanced',
      ambition: 'standard',
      created_at: now,
    })
    await db
      .table('user_ai_preferences')
      .multiInsert([
        preference(user.id, 'openai-codex', 'openai-native'),
        preference(other.id, 'anthropic', 'xai'),
      ])

    const migration = new Migration(db.connection(), 'test', false)
    await migration.execUp()

    const providers = await db
      .from('provider_credentials')
      .orderBy('provider_id')
      .select('provider_id')
    assert.deepEqual(
      providers.map((row) => row.provider_id),
      ['anthropic', 'chatgpt', 'openai', 'openai-compatible']
    )
    const preferences = await db.from('user_ai_preferences').select('*')
    assert.lengthOf(preferences, 1, 'the preference naming xai is gone')
    assert.equal(preferences[0].agent_provider_id, 'chatgpt')
    assert.equal(preferences[0].alternative_provider_id, 'openai')
  })
})
