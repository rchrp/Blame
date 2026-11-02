import VercelConnection from '#models/vercel_connection'
import Project from '#models/project'
import encryption from '@adonisjs/core/services/encryption'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { createLicensedUser } from '#tests/helpers/create_licensed_user'

test.group('Vercel deployments', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('lists only safe installation metadata and no provider token', async ({
    client,
    assert,
  }) => {
    const user = await createLicensedUser()
    const token = 'sensitive-vercel-installation-token'
    await VercelConnection.create({
      userId: user.id,
      configurationId: 'icfg_123',
      scopeType: 'personal',
      teamId: null,
      scopeKey: 'personal',
      scopeDisplayName: 'alex',
      encryptedAccessToken: await encryption.encrypt(token),
      status: 'active',
      lastValidatedAt: null,
      removedAt: null,
    })
    const response = await client.get('/api/v1/integrations/vercel/connections').loginAs(user)
    response.assertStatus(200)
    const body = response.body()
    assert.equal(body.connections[0].scopeDisplayName, 'alex')
    assert.notInclude(JSON.stringify(body), token)
    assert.notProperty(body.connections[0], 'configurationId')
    assert.notProperty(body.connections[0], 'teamId')
  })

  test('returns empty project deployment state without touching Vercel', async ({ client }) => {
    const user = await createLicensedUser()
    const project = await Project.create({
      userId: user.id,
      name: 'Site',
      repositoryFingerprint: `sha256:${'a'.repeat(64)}`,
    })
    const projectId = project.id
    const target = await client.get(`/api/v1/projects/${projectId}/deploy-target`).loginAs(user)
    target.assertStatus(200)
    target.assertBodyContains({ target: null })
    const deployments = await client.get(`/api/v1/projects/${projectId}/deployments`).loginAs(user)
    deployments.assertStatus(200)
    deployments.assertBodyContains({ deployments: [] })
  })

  test('protects deployment state from another user', async ({ client }) => {
    const owner = await createLicensedUser()
    const other = await createLicensedUser()
    const project = await Project.create({
      userId: owner.id,
      name: 'Private site',
      repositoryFingerprint: `sha256:${'b'.repeat(64)}`,
    })
    const response = await client.get(`/api/v1/projects/${project.id}/deployments`).loginAs(other)
    response.assertStatus(403)
  })
})
