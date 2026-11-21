import EngineSession from '#models/engine_session'
import Epic from '#models/epic'
import Project from '#models/project'
import User from '#models/user'
import env from '#start/env'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { createLicensedUser as createUser } from '../helpers/create_licensed_user.js'

type EpicData = {
  branch: string | null
  createdAt: string
  engineSessionId: string | null
  goal: string | null
  id: string
  mergeCommit: string | null
  mergedAt: string | null
  projectId: string
  settings: Record<string, unknown>
  status: string
  targetBranch: string | null
  title: string
  updatedAt: string | null
}

const keys = [
  'branch',
  'createdAt',
  'engineSessionId',
  'goal',
  'id',
  'mergeCommit',
  'mergedAt',
  'projectId',
  'settings',
  'status',
  'targetBranch',
  'title',
  'updatedAt',
]

const path = '/api/v1/projects/epics'

test.group('epics', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('creates an epic that starts active with no settings', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id)

    const response = await client
      .post(path)
      .loginAs(user)
      .json({ projectId: project.id, title: 'Checkout flow' })

    response.assertStatus(200)
    const epic = data(response)
    assert.sameMembers(Object.keys(epic), keys)
    assert.equal(epic.projectId, project.id)
    assert.equal(epic.title, 'Checkout flow')
    assert.equal(epic.status, 'active')
    assert.deepEqual(epic.settings, {})
    for (const key of [
      'goal',
      'branch',
      'targetBranch',
      'engineSessionId',
      'mergedAt',
      'mergeCommit',
    ] as const) {
      assert.isNull(epic[key])
    }
  })

  test('keeps every field it is given and changes them', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const settings = {
      modelRange: { min: 0.2, max: 0.8 },
      providers: ['anthropic', 'openai'],
      budgetMicroUsd: 5_000_000,
      askBeforeLaunch: true,
      other: { kept: 'as sent' },
    }
    const engineSessionId = sessionId()

    const created = await client.post(path).loginAs(user).json({
      projectId: project.id,
      title: 'Checkout flow',
      goal: 'Pay with a card',
      status: 'paused',
      branch: 'epic/checkout',
      targetBranch: 'main',
      engineSessionId,
      settings,
    })
    created.assertStatus(200)
    const epic = data(created)
    assert.equal(epic.goal, 'Pay with a card')
    assert.equal(epic.status, 'paused')
    assert.equal(epic.branch, 'epic/checkout')
    assert.equal(epic.targetBranch, 'main')
    assert.equal(epic.engineSessionId, engineSessionId)
    assert.deepEqual(epic.settings, settings)

    const updated = await client
      .patch(`${path}/${epic.id}`)
      .loginAs(user)
      .json({
        title: 'Checkout',
        status: 'completed',
        mergedAt: '2026-11-21T10:00:00.000Z',
        mergeCommit: 'abc123',
        settings: { askBeforeLaunch: false },
      })
    updated.assertStatus(200)
    const changed = data(updated)
    assert.equal(changed.title, 'Checkout')
    assert.equal(changed.status, 'completed')
    assert.equal(changed.mergeCommit, 'abc123')
    assert.equal(new Date(changed.mergedAt!).toISOString(), '2026-11-21T10:00:00.000Z')
    // What the update does not name stays; the settings are replaced whole.
    assert.equal(changed.goal, 'Pay with a card')
    assert.equal(changed.branch, 'epic/checkout')
    assert.equal(changed.engineSessionId, engineSessionId)
    assert.deepEqual(changed.settings, { askBeforeLaunch: false })

    const cleared = await client
      .patch(`${path}/${epic.id}`)
      .loginAs(user)
      .json({ goal: null, branch: null, engineSessionId: null, mergedAt: null })
    cleared.assertStatus(200)
    assert.isNull(data(cleared).goal)
    assert.isNull(data(cleared).engineSessionId)
    assert.isNull(data(cleared).mergedAt)

    const shown = await client.get(`${path}/${epic.id}`).loginAs(user)
    shown.assertStatus(200)
    assert.deepEqual(data(shown), data(cleared))
  })

  test('lists the epics of one project, oldest first', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const other = await createProject(user.id)
    const first = await createEpic(client, user, project.id, 'First')
    const second = await createEpic(client, user, project.id, 'Second')
    await createEpic(client, user, other.id, 'Elsewhere')

    const response = await client.get(path).qs({ projectId: project.id }).loginAs(user)

    response.assertStatus(200)
    assert.deepEqual(
      (response.body() as { data: EpicData[] }).data.map((epic) => epic.id),
      [first.id, second.id]
    )
    const missing = await client.get(path).loginAs(user)
    missing.assertStatus(422)
  })

  test('refuses settings with an invalid known key', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const epic = await createEpic(client, user, project.id, 'Goal')

    for (const settings of [
      { modelRange: { min: 0.8, max: 0.2 } },
      { modelRange: { min: -0.1, max: 0.5 } },
      { modelRange: { min: 0, max: 1.5 } },
      { modelRange: { min: 0.5 } },
      { modelRange: 'wide' },
      { providers: ['cline'] },
      { providers: 'anthropic' },
      { budgetMicroUsd: 'a lot' },
      { budgetMicroUsd: -1 },
      { askBeforeLaunch: 'yes' },
      'nothing',
    ]) {
      const update = await client.patch(`${path}/${epic.id}`).loginAs(user).json({ settings })
      update.assertStatus(422)
      const create = await client
        .post(path)
        .loginAs(user)
        .json({ projectId: project.id, title: 'Invalid', settings })
      create.assertStatus(422)
    }
    const edges = await client
      .patch(`${path}/${epic.id}`)
      .loginAs(user)
      .json({ settings: { modelRange: { min: 0.5, max: 0.5 }, budgetMicroUsd: 0 } })
    edges.assertStatus(200)
    assert.lengthOf(await Epic.all(), 1)
  })

  test('refuses an unknown status and a missing title', async ({ client }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const epic = await createEpic(client, user, project.id, 'Goal')

    for (const body of [{ status: 'finished' }, { title: 'x'.repeat(256) }]) {
      const response = await client.patch(`${path}/${epic.id}`).loginAs(user).json(body)
      response.assertStatus(422)
    }
    const created = await client.post(path).loginAs(user).json({ projectId: project.id, title: '' })
    created.assertStatus(422)
  })

  test('refuses an engine session id that is invalid, taken or of another account', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const stranger = await createUser()
    const project = await createProject(user.id)
    const first = await createEpic(client, user, project.id, 'First')
    const second = await createEpic(client, user, project.id, 'Second')
    const engineSessionId = sessionId()
    const named = await client.patch(`${path}/${first.id}`).loginAs(user).json({ engineSessionId })
    named.assertStatus(200)
    const foreignSession = sessionId()
    assert.equal(await pushRecords(stranger, foreignSession), 200)

    for (const invalid of ['has space', 'x'.repeat(65), 'é', engineSessionId]) {
      const response = await client
        .patch(`${path}/${second.id}`)
        .loginAs(user)
        .json({ engineSessionId: invalid })
      response.assertStatus(422)
    }
    const taken = await client
      .post(path)
      .loginAs(user)
      .json({ projectId: project.id, title: 'Third', engineSessionId })
    taken.assertStatus(422)
    const foreign = await client
      .patch(`${path}/${second.id}`)
      .loginAs(user)
      .json({ engineSessionId: foreignSession })
    foreign.assertStatus(403)
    const same = await client.patch(`${path}/${first.id}`).loginAs(user).json({ engineSessionId })
    same.assertStatus(200)
  })

  test('deleting an epic keeps its stories and deletes its engine session', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const epic = await createEpic(client, user, project.id, 'Goal')
    const kept = await createEpic(client, user, project.id, 'Kept')
    const engineSessionId = sessionId()
    await client.patch(`${path}/${epic.id}`).loginAs(user).json({ engineSessionId })
    assert.equal(await pushRecords(user, engineSessionId), 200)
    const story = await createStory(client, user, project.id, epic.id)
    const sibling = await createStory(client, user, project.id, kept.id)

    const response = await client.delete(`${path}/${epic.id}`).loginAs(user)

    response.assertStatus(204)
    assert.isNull(await Epic.find(epic.id))
    assert.isNull(await EngineSession.find(engineSessionId))
    const records = await db.from('engine_session_records').where('session_id', engineSessionId)
    assert.lengthOf(records, 0)
    const shown = await client.get(`/api/v1/projects/user-stories/${story}`).loginAs(user)
    shown.assertStatus(200)
    assert.isNull((shown.body() as { data: { epicId: string | null } }).data.epicId)
    const other = await client.get(`/api/v1/projects/user-stories/${sibling}`).loginAs(user)
    assert.equal((other.body() as { data: { epicId: string | null } }).data.epicId, kept.id)
    const again = await client.delete(`${path}/${epic.id}`).loginAs(user)
    again.assertStatus(404)
  })

  test('deletes an epic whose session the engine never pushed', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const epic = await createEpic(client, user, project.id, 'Goal')
    await client.patch(`${path}/${epic.id}`).loginAs(user).json({ engineSessionId: sessionId() })

    const response = await client.delete(`${path}/${epic.id}`).loginAs(user)

    response.assertStatus(204)
    assert.isNull(await Epic.find(epic.id))
  })

  test("another user's epics and projects are not found", async ({ client, assert }) => {
    const owner = await createUser()
    const stranger = await createUser()
    const project = await createProject(owner.id)
    const epic = await createEpic(client, owner, project.id, 'Private')

    const list = await client.get(path).qs({ projectId: project.id }).loginAs(stranger)
    const create = await client
      .post(path)
      .loginAs(stranger)
      .json({ projectId: project.id, title: 'Intruder' })
    const show = await client.get(`${path}/${epic.id}`).loginAs(stranger)
    const update = await client
      .patch(`${path}/${epic.id}`)
      .loginAs(stranger)
      .json({ title: 'Mine now' })
    const destroy = await client.delete(`${path}/${epic.id}`).loginAs(stranger)

    for (const response of [list, create, show, update, destroy]) response.assertStatus(404)
    const kept = await Epic.findOrFail(epic.id)
    assert.equal(kept.title, 'Private')
    assert.lengthOf(await Epic.all(), 1)
  })
})

async function createEpic(client: ApiClient, user: User, projectId: string, title: string) {
  const response = await client.post(path).loginAs(user).json({ projectId, title })
  response.assertStatus(200)
  return data(response)
}

async function createStory(client: ApiClient, user: User, projectId: string, epicId: string) {
  const response = await client
    .post('/api/v1/projects/user-stories')
    .loginAs(user)
    .json({ projectId, title: 'Story', summary: 'Part of an epic', epicId })
  response.assertStatus(200)
  return (response.body() as { data: { id: string } }).data.id
}

function data(response: { body(): unknown }) {
  return (response.body() as { data: EpicData }).data
}

/** Pushes the first record of a session the way the desktop relays the engine's log. */
async function pushRecords(user: User, id: string) {
  const token = await User.accessTokens.create(user)
  const response = await fetch(
    `http://${env.get('HOST')}:${env.get('PORT')}/api/v1/engine/sessions/${id}/records`,
    {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token.value!.release()}`,
        'content-type': 'application/octet-stream',
      },
      body: JSON.stringify({
        records: [
          {
            seq: 1,
            at_ms: Date.now(),
            type: 'session_created',
            config: { purpose: 'orchestrator', workspace_root: '/work' },
          },
        ],
      }),
    }
  )
  return response.status
}

function sessionId() {
  return `epic-${randomUUID()}`
}

function createProject(userId: string) {
  return Project.create({ name: 'Alpha', repositoryFingerprint: randomUUID(), userId })
}
