import { migrateLegacyAttachments } from '../../commands/migrate_attachments_to_s3.js'
import FileAttachment from '#models/file_attachment'
import Project from '#models/project'
import User from '#models/user'
import UserSubscription from '#models/user_subscription'
import UserStory from '#models/user_story'
import { attachmentObjectStorage } from '#services/attachment_object_storage'
import FileAttachmentsService from '#services/file_attachments_service'
import { createLicensedUser as createUser } from '../helpers/create_licensed_user.js'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import type { Assert } from '@japa/assert'
import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'

const content = Buffer.from('Hello')
const checksumSha256 = createHash('sha256').update(content).digest('hex')

test.group('file attachments', (group) => {
  group.setup(async () => {
    await testUtils.db().migrate()
  })
  group.each.setup(() => testUtils.db().truncate())

  test('uploads, attaches, authorizes and exports an object', async ({ client, assert }) => {
    const user = await createUser()
    const stranger = await createUser()
    const project = await createProject(user.id)
    const id = crypto.randomUUID()
    const legacyUpload = {
      aiContextMarkdown: 'Ignored metadata from an older client',
      checksumSha256,
      id,
      name: 'hello.txt',
      size: content.byteLength,
      type: 'text/plain',
    }
    const createResponse = await client
      .post('/api/v1/attachments/uploads')
      .loginAs(user)
      .json(legacyUpload)

    createResponse.assertStatus(200)
    const createdUpload = createResponse.body() as unknown as UploadBody
    assert.equal(createdUpload.attachment.id, id)
    assert.notProperty(createdUpload.attachment, 'aiContextMarkdown')
    assert.match(createdUpload.upload?.url ?? '', /^memory:/)
    await attachmentObjectStorage().put(`${user.id}/${id}`, content, {
      checksumSha256,
      contentType: 'text/plain',
      size: content.byteLength,
    })

    const completeResponse = await client.post(`/api/v1/attachments/${id}/complete`).loginAs(user)
    completeResponse.assertStatus(200)
    const completedUpload = completeResponse.body() as unknown as { downloadUrl: string }
    assert.match(completedUpload.downloadUrl, /^memory:/)

    const storyResponse = await client
      .post('/api/v1/projects/user-stories')
      .loginAs(user)
      .json({
        fileAttachments: [
          {
            id,
            name: 'hello.txt',
            size: content.byteLength,
            type: 'text/plain',
          },
        ],
        projectId: project.id,
        summary: 'Stored outside MySQL',
        title: 'Object storage',
      })
    storyResponse.assertStatus(200)
    const story = storyResponse.body() as unknown as StoryBody
    assert.notProperty(story.data.fileAttachments[0], 'content')
    const storedReference = {
      id,
      name: 'hello.txt',
      size: content.byteLength,
      type: 'text/plain',
    }
    const commentResponse = await client
      .post(`/api/v1/projects/user-stories/${story.data.id}/comments`)
      .loginAs(user)
      .json({ body: 'Stored reference', fileAttachments: [storedReference] })
    commentResponse.assertStatus(200)
    const chatResponse = await client
      .post('/api/v1/projects/quick-chats')
      .loginAs(user)
      .json({ projectId: project.id, title: 'Stored reference' })
    chatResponse.assertStatus(200)
    const chat = chatResponse.body() as unknown as StoryBody
    const messageResponse = await client
      .post(`/api/v1/projects/quick-chats/${chat.data.id}/messages`)
      .loginAs(user)
      .json({ body: 'Stored reference', fileAttachments: [storedReference] })
    messageResponse.assertStatus(200)

    const unauthorizedResponse = await client.get(`/api/v1/attachments/${id}`).loginAs(stranger)
    unauthorizedResponse.assertStatus(404)

    const legacyColumn = await db
      .from('user_stories')
      .select('file_attachments')
      .where('id', story.data.id)
      .firstOrFail()
    assert.isNull(legacyColumn.file_attachments)

    const exportResponse = await client
      .post('/api/v1/account/export')
      .loginAs(user)
      .json({ password: 'password123' })
    exportResponse.assertStatus(200)
    const accountExport = exportResponse.body() as unknown as AccountExportBody
    assert.equal(accountExport.version, 2)
    assert.equal(accountExport.workspace.fileAttachments[0].content, 'SGVsbG8=')

    await UserSubscription.query().where('userId', user.id).delete()
    const closureResponse = await client.post('/api/v1/account/closure').loginAs(user).json({
      confirmation: user.email,
      password: 'password123',
    })
    closureResponse.assertStatus(200)
    assert.isNull(await User.find(user.id))
    assert.isNull(await FileAttachment.find(id))
    await assert.rejects(() => attachmentObjectStorage().content(`${user.id}/${id}`))
  })

  test('migrates existing legacy attachments without a subscription, once', async ({ assert }) => {
    const user = await createUser()
    await UserSubscription.query().where('userId', user.id).delete()
    const project = await createProject(user.id)
    const story = await UserStory.create({
      legacyFileAttachments: [
        {
          content: 'SGVsbG8=',
          id: 'legacy-file',
          name: 'legacy.txt',
          size: 5,
          type: 'text/plain',
        },
      ],
      owner: 'Product',
      priority: 'Medium',
      projectId: project.id,
      status: 'backlog',
      storyNumber: 1,
      summary: 'Migrate this attachment',
      title: 'Legacy attachment',
    })

    assert.equal(await migrateLegacyAttachments(), 1)
    assert.equal(await migrateLegacyAttachments(), 0)
    await story.refresh()
    await story.load('storedFileAttachments')
    assert.isNull(story.legacyFileAttachments)
    assert.equal(story.fileAttachments?.[0]?.id, 'legacy-file')
    assert.equal(
      Buffer.from(await attachmentObjectStorage().content(`${user.id}/legacy-file`)).toString(),
      'Hello'
    )
  })

  test('migrates a large legacy attachment without overflowing the stack', async ({ assert }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const largeContent = Buffer.alloc(5 * 1024 * 1024, 65)
    const story = await UserStory.create({
      legacyFileAttachments: [
        {
          content: largeContent.toString('base64'),
          id: 'large-legacy-file',
          name: 'large-legacy-file.bin',
          size: largeContent.byteLength,
          type: 'application/octet-stream',
        },
      ],
      owner: 'Product',
      priority: 'Medium',
      projectId: project.id,
      status: 'backlog',
      storyNumber: 1,
      summary: 'Migrate a large attachment',
      title: 'Large legacy attachment',
    })

    assert.equal(await migrateLegacyAttachments(), 1)
    await story.refresh()
    assert.isNull(story.legacyFileAttachments)
    const storedContent = await attachmentObjectStorage().content(`${user.id}/large-legacy-file`)
    assert.equal(sha256(storedContent), sha256(largeContent))
  })

  test('persists attachment upload state without changing the story status', async ({
    assert,
    client,
  }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const createResponse = await client.post('/api/v1/projects/user-stories').loginAs(user).json({
      fileAttachmentUploadPending: true,
      projectId: project.id,
      status: 'ready',
      summary: 'Use the local attachment while persistence continues',
      title: 'Local attachment source',
    })
    createResponse.assertStatus(200)
    const createdStory = createResponse.body() as unknown as {
      data: { fileAttachmentUploadPending: boolean; id: string; status: string }
    }
    assert.isTrue(createdStory.data.fileAttachmentUploadPending)
    assert.equal(createdStory.data.status, 'ready')

    const updateResponse = await client
      .patch(`/api/v1/projects/user-stories/${createdStory.data.id}`)
      .loginAs(user)
      .json({ fileAttachmentUploadPending: false })
    updateResponse.assertStatus(200)
    assert.isFalse(
      (
        updateResponse.body() as unknown as {
          data: { fileAttachmentUploadPending: boolean }
        }
      ).data.fileAttachmentUploadPending
    )
  })

  test('purges detached attachment objects after the grace period', async ({ assert, client }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const storyResponse = await client
      .post('/api/v1/projects/user-stories')
      .loginAs(user)
      .json({
        fileAttachments: [
          {
            content: 'SGVsbG8=',
            id: 'detached-file',
            name: 'detached.txt',
            size: 5,
            type: 'text/plain',
          },
        ],
        projectId: project.id,
        summary: 'Delete this attachment',
        title: 'Detached attachment',
      })
    storyResponse.assertStatus(200)
    const story = storyResponse.body() as unknown as StoryBody
    const deleteResponse = await client
      .delete(`/api/v1/projects/user-stories/${story.data.id}`)
      .loginAs(user)
    deleteResponse.assertStatus(204)
    await FileAttachment.query()
      .where('id', 'detached-file')
      .update({ detachedAt: DateTime.utc().minus({ hours: 25 }).toJSDate() })

    assert.equal(await new FileAttachmentsService().cleanupOrphans(), 1)
    assert.isNull(await FileAttachment.find('detached-file'))
    await assert.rejects(() => attachmentObjectStorage().content(`${user.id}/detached-file`))
  })

  test('stores comment and quick chat message attachments as objects', async ({
    assert,
    client,
  }) => {
    const user = await createUser()
    const project = await createProject(user.id)
    const storyResponse = await client.post('/api/v1/projects/user-stories').loginAs(user).json({
      projectId: project.id,
      summary: 'Attachment owners',
      title: 'Attachment owners',
    })
    storyResponse.assertStatus(200)
    const story = storyResponse.body() as unknown as StoryBody
    const commentResponse = await client
      .post(`/api/v1/projects/user-stories/${story.data.id}/comments`)
      .loginAs(user)
      .json({
        body: 'Comment attachment',
        fileAttachments: [inlineAttachment('comment-file')],
      })
    commentResponse.assertStatus(200)
    assertStoredReference(commentResponse.body(), 'comment-file', assert)

    const chatResponse = await client
      .post('/api/v1/projects/quick-chats')
      .loginAs(user)
      .json({ projectId: project.id, title: 'Attachment chat' })
    chatResponse.assertStatus(200)
    const chat = chatResponse.body() as unknown as StoryBody
    const messageResponse = await client
      .post(`/api/v1/projects/quick-chats/${chat.data.id}/messages`)
      .loginAs(user)
      .json({
        body: 'Message attachment',
        fileAttachments: [inlineAttachment('message-file')],
      })
    messageResponse.assertStatus(200)
    assertStoredReference(messageResponse.body(), 'message-file', assert)

    assert.equal(await attachmentLinkCount('user_story_comment_file_attachments'), 1)
    assert.equal(await attachmentLinkCount('quick_chat_message_file_attachments'), 1)
  })
})

type UploadBody = {
  attachment: { id: string }
  upload: { url: string } | null
}

type StoryBody = {
  data: {
    fileAttachments: Record<string, unknown>[]
    id: string
  }
}

type AccountExportBody = {
  version: number
  workspace: {
    fileAttachments: { content: string }[]
  }
}

function inlineAttachment(id: string) {
  return {
    content: 'SGVsbG8=',
    id,
    name: `${id}.txt`,
    size: 5,
    type: 'text/plain',
  }
}

function assertStoredReference(value: unknown, id: string, assert: Assert) {
  const body = value as { data: { fileAttachments: Record<string, unknown>[] } }
  assert.equal(body.data.fileAttachments[0]?.id, id)
  assert.match(String(body.data.fileAttachments[0]?.downloadUrl), /^memory:/)
  assert.notProperty(body.data.fileAttachments[0] ?? {}, 'content')
}

async function attachmentLinkCount(table: string) {
  const rows = await db.from(table).count('* as total')
  return Number(rows[0]?.total ?? 0)
}

function sha256(value: Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

function createProject(userId: string) {
  return Project.create({
    name: 'Attachments',
    repositoryFingerprint: crypto.randomUUID(),
    userId,
  })
}
