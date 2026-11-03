import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import {
  forgetPreviewEnvironment,
  loadPreviewEnvironment,
  storePreviewEnvironment,
} from '#services/preview_sessions/preview_environment_secrets'

const environment = {
  variables: { api: { STRIPE_SECRET_KEY: 'sk_test_secret_value' } },
  files: [{ path: 'packages/api/.env', content: 'DATABASE_URL=mysql://u:hunter2@db/app\n' }],
}

test.group('preview environment secrets', (group) => {
  group.each.setup(async () => {
    await db.from('preview_session_environments').delete()
  })

  test('keeps a preview environment encrypted and gives it back to the runner', async ({
    assert,
  }) => {
    await storePreviewEnvironment('session-1', environment)
    const row = await db
      .from('preview_session_environments')
      .where('session_id', 'session-1')
      .first()
    assert.notInclude(row.environment_encrypted, 'sk_test_secret_value')
    assert.notInclude(row.environment_encrypted, 'hunter2')
    assert.deepEqual(await loadPreviewEnvironment('session-1'), environment)

    const changed = {
      variables: { api: { STRIPE_SECRET_KEY: 'sk_test_rotated' } },
      files: [],
    }
    await storePreviewEnvironment('session-1', changed)
    assert.deepEqual(await loadPreviewEnvironment('session-1'), changed)
    assert.lengthOf(await db.from('preview_session_environments'), 1)
  })

  test('forgets it when none is sent', async ({ assert }) => {
    await storePreviewEnvironment('session-2', environment)
    await storePreviewEnvironment('session-2', undefined)
    assert.isUndefined(await loadPreviewEnvironment('session-2'))
    await storePreviewEnvironment('session-3', environment)
    await forgetPreviewEnvironment('session-3')
    assert.isUndefined(await loadPreviewEnvironment('session-3'))
  })
})
