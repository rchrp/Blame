import Project from '#models/project'
import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

type ProjectBody = {
  data: {
    id: string
    name: string
    repositoryFingerprint: string | null
  }
}

test.group('projects', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('reuses a legacy project without repository fingerprint', async ({ client, assert }) => {
    const user = await createUser()
    const legacyProject = await Project.create({
      name: 'Alpha',
      repositoryFingerprint: null,
      userId: user.id,
    })

    const response = await client.post('/api/v1/projects').loginAs(user).json({
      name: 'Alpha',
      repositoryFingerprint: 'git:fingerprint-alpha',
    })

    response.assertStatus(200)
    const body = response.body() as ProjectBody
    assert.equal(body.data.id, legacyProject.id)
    assert.equal(body.data.repositoryFingerprint, 'git:fingerprint-alpha')

    const projects = await Project.query().where('userId', user.id)
    assert.lengthOf(projects, 1)
  })

  test('creates a new project when the fingerprint does not match another repository', async ({
    client,
    assert,
  }) => {
    const user = await createUser()

    await Project.create({
      name: 'Alpha',
      repositoryFingerprint: null,
      userId: user.id,
    })

    const response = await client.post('/api/v1/projects').loginAs(user).json({
      name: 'Beta',
      repositoryFingerprint: 'git:fingerprint-beta',
    })

    response.assertStatus(200)
    const body = response.body() as ProjectBody
    assert.equal(body.data.name, 'Beta')
    assert.equal(body.data.repositoryFingerprint, 'git:fingerprint-beta')

    const projects = await Project.query().where('userId', user.id)
    assert.lengthOf(projects, 2)
  })
})

function createUser() {
  return User.create({
    email: `${crypto.randomUUID()}@example.com`,
    password: 'password123',
  })
}
