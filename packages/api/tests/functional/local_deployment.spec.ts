import User from '#models/user'
import { deployment } from '#lib/deployment'
import LocalSessionService from '#services/local_session_service'
import type { WorkspaceBundle } from '#services/workspace_transfer_service'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

// Run with BLAME_DEPLOYMENT=local DB_CONNECTION=sqlite, as the desktop app does.
const skipped = deployment.hostedServices ? 'Runs against the local API only' : false

const hostedRequests = [
  ['get', '/api/v1/billing'],
  ['post', '/api/v1/auth/sign-in/email'],
  ['post', '/api/v1/web/search'],
  ['get', '/api/v1/preview-sessions'],
  ['post', '/api/v1/speech/transcriptions'],
  ['post', '/api/v1/account/export'],
  ['get', '/api/v1/projects/01a19910-96a1-79a4-b933-df4ae67dd9eb/deployments'],
] as const

test.group('local API', (group) => {
  group.tap((t) => t.skip(Boolean(skipped), skipped || undefined))
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('issues a token for the single local user and revokes the previous one', async ({
    client,
    assert,
  }) => {
    const sessions = new LocalSessionService()
    const first = await sessions.start()
    const second = await sessions.start()

    const revoked = await client.get('/api/v1/account/profile').bearerToken(first)
    const current = await client.get('/api/v1/account/profile').bearerToken(second)

    revoked.assertStatus(401)
    current.assertStatus(200)
    assert.equal(current.body().data.email, 'local@blame.invalid')
    assert.equal(
      await User.query()
        .count('* as total')
        .first()
        .then((row) => row?.$extras.total),
      1
    )
  })

  test('refuses requests without the local token', async ({ client }) => {
    const response = await client.get('/api/v1/projects')
    response.assertStatus(401)
  })

  test('answers that hosted services need an account', async ({ client }) => {
    const token = await new LocalSessionService().start()
    for (const [method, path] of hostedRequests) {
      const response = await client[method](path).bearerToken(token)
      response.assertStatus(403)
      response.assertBodyContains({ code: 'ACCOUNT_REQUIRED' })
    }
  })

  test('refuses hosted uploads with the same answer', async ({ client }) => {
    const token = await new LocalSessionService().start()
    const response = await client
      .post('/api/v1/attachments/uploads')
      .bearerToken(token)
      .json({
        id: '01a19910-96a1-79a4-b933-df4ae67dd9eb',
        name: 'notes.txt',
        type: 'text/plain',
        size: 4,
        checksumSha256: 'a'.repeat(64),
      })
    response.assertStatus(402)
    response.assertBodyContains({ code: 'ACCOUNT_REQUIRED', feature: 'cloud_storage' })
  })

  test('keeps projects and stories on this computer', async ({ client, assert }) => {
    const token = await new LocalSessionService().start()
    const project = await client
      .post('/api/v1/projects')
      .bearerToken(token)
      .json({ name: 'Shop', repositoryFingerprint: 'fingerprint-shop' })
    project.assertStatus(200)
    const projectId = (project.body() as { data: { id: string } }).data.id
    const story = await client
      .post('/api/v1/projects/user-stories')
      .bearerToken(token)
      .json({ projectId, title: 'Checkout', summary: 'Pay' })
    story.assertStatus(200)

    const workspace = await client.get('/api/v1/account/workspace').bearerToken(token)
    workspace.assertStatus(200)
    // Only the local API registers this export: the typed client, made from
    // the hosted routes, takes it for the import that shares its path.
    const bundle = workspace.body() as unknown as { data: WorkspaceBundle }
    assert.lengthOf(bundle.data.tables.user_stories ?? [], 1)
  })
})
