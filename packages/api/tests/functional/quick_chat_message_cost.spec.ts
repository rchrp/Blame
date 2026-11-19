import FileAttachment from '#models/file_attachment'
import Project from '#models/project'
import QuickChatMessage from '#models/quick_chat_message'
import User from '#models/user'
import { attachmentObjectStorage } from '#services/attachment_object_storage'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

type Body = { data: { id: string } }

test.group('quick chat message cost', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('sends a message, starts its run and marks the chat running without signing earlier attachments', async ({
    assert,
    client,
  }) => {
    const user = await createUser()
    const chat = await createChat(client, user, await createProject(user.id))
    for (let message = 0; message < 10; message++) {
      const attachments = await readyAttachments(user.id, 5)
      const response = await client
        .post(`/api/v1/projects/quick-chats/${chat}/messages`)
        .loginAs(user)
        .json({ body: `Earlier ${message}`, fileAttachments: attachments })
      response.assertStatus(200)
    }

    let messageId = ''
    const message = await measured(async () => {
      const response = await client
        .post(`/api/v1/projects/quick-chats/${chat}/messages`)
        .loginAs(user)
        .json({ body: 'Short' })
      response.assertStatus(200)
      messageId = (response.body() as Body).data.id
    })
    const run = await measured(async () => {
      const response = await client
        .post(`/api/v1/projects/quick-chats/${chat}/agent-runs`)
        .loginAs(user)
        .json({ kind: 'resume', messageId })
      response.assertStatus(200)
    })
    assert.equal(message.signatures, 0)
    assert.equal(run.signatures, 0)
    const running = await measured(async () => {
      const response = await client
        .patch(`/api/v1/projects/quick-chats/${chat}`)
        .loginAs(user)
        .json({ agentStatus: 'Running' })
      response.assertStatus(200)
    })
    assert.equal(running.signatures, 0)
  })

  test('refuses a chat, a message and an attachment the user may not use', async ({
    assert,
    client,
  }) => {
    const user = await createUser()
    const stranger = await createUser()
    const chat = await createChat(client, user, await createProject(user.id))
    const otherChat = await createChat(client, user, await createProject(user.id))
    const otherMessage = await createMessage(client, user, otherChat)
    const strangerChat = await createChat(client, stranger, await createProject(stranger.id))
    const strangerMessage = await createMessage(client, stranger, strangerChat)
    const [strangerAttachment] = await readyAttachments(stranger.id, 1)
    const message = await createMessage(client, user, chat)

    const foreignMessage = await client
      .post(`/api/v1/projects/quick-chats/${chat}/messages`)
      .loginAs(stranger)
      .json({ body: 'Not my chat' })
    foreignMessage.assertStatus(404)
    const foreignRun = await client
      .post(`/api/v1/projects/quick-chats/${chat}/agent-runs`)
      .loginAs(stranger)
      .json({ kind: 'resume', messageId: message })
    foreignRun.assertStatus(404)
    const foreignUpdate = await client
      .patch(`/api/v1/projects/quick-chats/${chat}`)
      .loginAs(stranger)
      .json({ title: 'Taken over' })
    foreignUpdate.assertStatus(404)
    for (const messageId of [otherMessage, strangerMessage, crypto.randomUUID()]) {
      const misplacedRun = await client
        .post(`/api/v1/projects/quick-chats/${chat}/agent-runs`)
        .loginAs(user)
        .json({ kind: 'resume', messageId })
      misplacedRun.assertStatus(500)
      assert.equal(
        (misplacedRun.body() as { message?: string }).message,
        'Quick chat message not found.'
      )
    }
    const strangerFile = await client
      .post(`/api/v1/projects/quick-chats/${chat}/messages`)
      .loginAs(user)
      .json({ body: 'Not my file', fileAttachments: [strangerAttachment] })
    strangerFile.assertStatus(404)

    const messages = await QuickChatMessage.query().where('quickChatId', chat)
    assert.deepEqual(
      messages.map((row) => row.id),
      [message]
    )
    const runs = await db.from('quick_chat_agent_runs').where('quick_chat_id', chat)
    assert.lengthOf(runs, 0)
    const stored = await db.from('quick_chats').where('id', chat).firstOrFail()
    assert.equal(stored.title, 'Chat')
  })
})

// Signed download URLs and SQL queries while `action` runs.
async function measured(action: () => Promise<void>) {
  const storage = attachmentObjectStorage()
  const presignDownload = storage.presignDownload
  let signatures = 0
  storage.presignDownload = (...args) => {
    signatures += 1
    return presignDownload.apply(storage, args)
  }
  const connection = db.connection()
  const clients = new Set([connection.getWriteClient(), connection.getReadClient()])
  let queries = 0
  const count = () => (queries += 1)
  for (const knex of clients) knex.on('query', count)
  try {
    await action()
  } finally {
    storage.presignDownload = presignDownload
    for (const knex of clients) knex.off('query', count)
  }
  return { queries, signatures }
}

async function readyAttachments(userId: string, count: number) {
  return Promise.all(
    Array.from({ length: count }, async () => {
      const id = crypto.randomUUID()
      const metadata = { checksumSha256: 'a'.repeat(64), contentType: 'text/plain', size: 1 }
      await attachmentObjectStorage().put(`${userId}/${id}`, Uint8Array.from([1]), metadata)
      await FileAttachment.create({
        checksumSha256: 'a'.repeat(64),
        conversationAttachment: false,
        detachedAt: DateTime.utc(),
        id,
        mimeType: 'text/plain',
        name: `${id}.txt`,
        objectKey: `${userId}/${id}`,
        size: 1,
        status: 'ready',
        uploadedAt: DateTime.utc(),
        userId,
      })
      return { id, name: `${id}.txt`, size: 1, type: 'text/plain' }
    })
  )
}

async function createChat(client: ApiClient, user: User, project: Project) {
  const response = await client
    .post('/api/v1/projects/quick-chats')
    .loginAs(user)
    .json({ projectId: project.id, title: 'Chat' })
  response.assertStatus(200)
  return (response.body() as Body).data.id
}

async function createMessage(client: ApiClient, user: User, chat: string) {
  const response = await client
    .post(`/api/v1/projects/quick-chats/${chat}/messages`)
    .loginAs(user)
    .json({ body: 'Hello' })
  response.assertStatus(200)
  return (response.body() as Body).data.id
}

function createUser() {
  return User.create({ email: `${crypto.randomUUID()}@example.com`, password: 'password123' })
}

function createProject(userId: string) {
  return Project.create({ name: 'Project', repositoryFingerprint: crypto.randomUUID(), userId })
}
