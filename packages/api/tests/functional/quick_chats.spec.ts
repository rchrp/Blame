import EngineSession from '#models/engine_session'
import Project from '#models/project'
import User from '#models/user'
import env from '#start/env'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'

type QuickChatData = {
  createdAt: string
  engineSessionId: string | null
  id: string
  lastActivityAt: string
  projectId: string
  title: string
  updatedAt: string | null
  workspace: string | null
}

const keys = [
  'createdAt',
  'engineSessionId',
  'id',
  'lastActivityAt',
  'projectId',
  'title',
  'updatedAt',
  'workspace',
]

test.group('quick chats', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('creates a chat that names its engine session', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const engineSessionId = sessionId()

    const response = await client.post('/api/v1/projects/quick-chats').loginAs(user).json({
      projectId: project.id,
      title: 'Layout',
      workspace: '/workspace',
      engineSessionId,
    })

    response.assertStatus(200)
    const chat = data(response)
    assert.sameMembers(Object.keys(chat), keys)
    assert.equal(chat.projectId, project.id)
    assert.equal(chat.title, 'Layout')
    assert.equal(chat.workspace, '/workspace')
    assert.equal(chat.engineSessionId, engineSessionId)
    assert.equal(chat.lastActivityAt, chat.updatedAt)
  })

  test('lists chats by last activity, a push to the session included', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const older = await createChat(client, user, project.id, 'Older')
    const newer = await createChat(client, user, project.id, 'Newer')
    await ageChat(older.id, 2)
    await ageChat(newer.id, 1)
    const other = await createProject(user.id)
    await createChat(client, user, other.id, 'Other project')

    assert.deepEqual(await listedTitles(client, user, project.id), ['Newer', 'Older'])

    assert.equal(await pushRecords(user, older.engineSessionId!), 200)
    const session = await EngineSession.findOrFail(older.engineSessionId!)

    const listed = await list(client, user, project.id)
    assert.deepEqual(
      listed.map((chat) => chat.title),
      ['Older', 'Newer']
    )
    assert.equal(
      DateTime.fromISO(listed[0].lastActivityAt).toSeconds(),
      session.updatedAt.startOf('second').toSeconds()
    )
  })

  test('requires a project of the user to list', async ({ client }) => {
    const user = await createUser()
    const stranger = await createUser()
    const project = await createProject(stranger.id)

    const missing = await client.get('/api/v1/projects/quick-chats').loginAs(user)
    missing.assertStatus(422)
    const foreign = await client
      .get('/api/v1/projects/quick-chats')
      .qs({ projectId: project.id })
      .loginAs(user)
    foreign.assertStatus(404)
  })

  test('shows and renames a chat', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const chat = await createChat(client, user, project.id, 'Draft')

    const shown = await client.get(`/api/v1/projects/quick-chats/${chat.id}`).loginAs(user)
    shown.assertStatus(200)
    assert.deepEqual(data(shown), chat)

    const renamed = await client
      .patch(`/api/v1/projects/quick-chats/${chat.id}`)
      .loginAs(user)
      .json({ title: 'Final', workspace: null })
    renamed.assertStatus(200)
    assert.equal(data(renamed).title, 'Final')
    assert.isNull(data(renamed).workspace)
    assert.equal(data(renamed).engineSessionId, chat.engineSessionId)
  })

  test('deleting a chat deletes its engine session', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const pushed = await createChat(client, user, project.id, 'Pushed')
    const unpushed = await createChat(client, user, project.id, 'Never pushed')
    assert.equal(await pushRecords(user, pushed.engineSessionId!), 200)

    const response = await client.delete(`/api/v1/projects/quick-chats/${pushed.id}`).loginAs(user)
    response.assertStatus(204)
    assert.isNull(await EngineSession.find(pushed.engineSessionId!))
    const records = await db
      .from('engine_session_records')
      .where('session_id', pushed.engineSessionId!)
    assert.lengthOf(records, 0)

    const second = await client.delete(`/api/v1/projects/quick-chats/${unpushed.id}`).loginAs(user)
    second.assertStatus(204)
    assert.lengthOf(await list(client, user, project.id), 0)
  })

  test("another user's chat is not found", async ({ client, assert }) => {
    const owner = await createUser()
    const stranger = await createUser()
    const project = await createProject(owner.id)
    const chat = await createChat(client, owner, project.id, 'Private')
    assert.equal(await pushRecords(owner, chat.engineSessionId!), 200)

    const path = `/api/v1/projects/quick-chats/${chat.id}`
    const shown = await client.get(path).loginAs(stranger)
    shown.assertStatus(404)
    const renamed = await client.patch(path).loginAs(stranger).json({ title: 'Taken' })
    renamed.assertStatus(404)
    const deleted = await client.delete(path).loginAs(stranger)
    deleted.assertStatus(404)
    const created = await client.post('/api/v1/projects/quick-chats').loginAs(stranger).json({
      projectId: project.id,
      title: 'Intruder',
      engineSessionId: sessionId(),
    })
    created.assertStatus(404)
    assert.isNotNull(await EngineSession.find(chat.engineSessionId!))
    const owned = await client.get(path).loginAs(owner)
    assert.equal(data(owned).title, 'Private')
  })

  test('refuses an engine session id that is invalid, taken or of another account', async ({
    assert,
    client,
  }) => {
    const user = await createUser()
    const stranger = await createUser()
    const project = await createProject(user.id)
    const existing = await createChat(client, user, project.id, 'First')
    const foreignSession = sessionId()
    assert.equal(await pushRecords(stranger, foreignSession), 200)

    for (const engineSessionId of [undefined, '', 'has space', 'x'.repeat(65), 'é']) {
      const response = await client.post('/api/v1/projects/quick-chats').loginAs(user).json({
        projectId: project.id,
        title: 'Invalid',
        engineSessionId,
      })
      response.assertStatus(422)
    }
    const taken = await client.post('/api/v1/projects/quick-chats').loginAs(user).json({
      projectId: project.id,
      title: 'Taken',
      engineSessionId: existing.engineSessionId,
    })
    taken.assertStatus(422)
    const foreign = await client.post('/api/v1/projects/quick-chats').loginAs(user).json({
      projectId: project.id,
      title: 'Foreign',
      engineSessionId: foreignSession,
    })
    foreign.assertStatus(403)
  })
})

function data(response: { body(): unknown }) {
  return (response.body() as { data: QuickChatData }).data
}

async function createChat(client: ApiClient, user: User, projectId: string, title: string) {
  const response = await client
    .post('/api/v1/projects/quick-chats')
    .loginAs(user)
    .json({ projectId, title, engineSessionId: sessionId() })
  response.assertStatus(200)
  return data(response)
}

async function list(client: ApiClient, user: User, projectId: string) {
  const response = await client.get('/api/v1/projects/quick-chats').qs({ projectId }).loginAs(user)
  response.assertStatus(200)
  return (response.body() as { data: QuickChatData[] }).data
}

async function listedTitles(client: ApiClient, user: User, projectId: string) {
  const chats = await list(client, user, projectId)
  return chats.map((chat) => chat.title)
}

/** Moves the chat into the past: timestamps keep whole seconds on both databases. */
async function ageChat(id: string, hours: number) {
  const at = DateTime.utc().minus({ hours }).toFormat(db.connection().dialect.dateTimeFormat)
  await db.from('quick_chats').where('id', id).update({ created_at: at, updated_at: at })
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
            config: { purpose: 'quick_chat', workspace_root: '/work' },
          },
        ],
      }),
    }
  )
  return response.status
}

function createUser() {
  return User.create({ email: `${randomUUID()}@example.com`, password: 'password123' })
}

function createProject(userId: string) {
  return Project.create({ name: 'Quick chat project', repositoryFingerprint: randomUUID(), userId })
}

function sessionId() {
  return `quick-chat-${randomUUID()}`
}
