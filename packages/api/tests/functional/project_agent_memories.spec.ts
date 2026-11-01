import Project from '#models/project'
import ProjectAgentMemory from '#models/project_agent_memory'
import { createLicensedUser } from '#tests/helpers/create_licensed_user'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { createHash } from 'node:crypto'

test.group('project agent memories', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('stores validated project memory idempotently', async ({ client, assert }) => {
    const user = await createLicensedUser()
    const project = await createProject(user.id)
    const input = memoryInput()

    const first = await client
      .post(`/api/v1/projects/${project.id}/agent-memories`)
      .loginAs(user)
      .json(input)
    const repeated = await client
      .post(`/api/v1/projects/${project.id}/agent-memories`)
      .loginAs(user)
      .json(input)

    first.assertStatus(200)
    repeated.assertStatus(200)
    assert.equal((first.body() as MemoryBody).data.id, (repeated.body() as MemoryBody).data.id)
    assert.lengthOf(await ProjectAgentMemory.query().where('projectId', project.id), 1)
  })

  test('lists only memories owned by the authenticated project user', async ({
    client,
    assert,
  }) => {
    const owner = await createLicensedUser()
    const other = await createLicensedUser()
    const project = await createProject(owner.id)
    await client
      .post(`/api/v1/projects/${project.id}/agent-memories`)
      .loginAs(owner)
      .json(memoryInput())

    const listed = await client.get(`/api/v1/projects/${project.id}/agent-memories`).loginAs(owner)
    const rejected = await client
      .get(`/api/v1/projects/${project.id}/agent-memories`)
      .loginAs(other)

    listed.assertStatus(200)
    rejected.assertStatus(404)
    const records = listed.body() as unknown as Array<{ transformerData: MemoryBody['data'][] }>
    assert.lengthOf(records, 1)
    assert.deepEqual(records[0]!.transformerData[0]!.files, memoryInput().files)
  })

  test('rejects oversized memory payloads', async ({ client }) => {
    const user = await createLicensedUser()
    const project = await createProject(user.id)
    const response = await client
      .post(`/api/v1/projects/${project.id}/agent-memories`)
      .loginAs(user)
      .json({ ...memoryInput(), summary: 'x'.repeat(1601) })
    response.assertStatus(422)
  })
})

type MemoryBody = { data: { files: Array<{ hash: string; path: string }>; id: string } }

function createProject(userId: string) {
  return Project.create({
    name: 'Memory project',
    repositoryFingerprint: crypto.randomUUID(),
    userId,
  })
}

function memoryInput() {
  const candidate = {
    files: [{ hash: 'a'.repeat(64), path: 'src/carousel.tsx' }],
    objective: 'Add the project carousel',
    sourceRevisionId: 'revision-1',
    storyId: 'story-1',
    summary: 'Kept carousel state in the page component.',
    symbols: ['ProjectCarousel'],
    validationKind: 'build',
    validationTaskId: 'build',
  }
  return {
    ...candidate,
    fingerprint: createHash('sha256').update(JSON.stringify(candidate)).digest('hex'),
  }
}
