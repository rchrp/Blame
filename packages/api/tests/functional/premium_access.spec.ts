import User from '#models/user'
import UserSubscription from '#models/user_subscription'
import FileAttachment from '#models/file_attachment'
import FileAttachmentsService from '#services/file_attachments_service'
import { attachmentObjectStorage } from '#services/attachment_object_storage'
import { createLicensedUser } from '#tests/helpers/create_licensed_user'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

test.group('Premium access', (group) => {
  group.setup(async () => {
    await testUtils.db().migrate()
  })
  group.each.setup(() => testUtils.db().truncate())

  test('keeps core and Premium endpoints authenticated', async ({ client }) => {
    const core = await client.get('/api/v1/projects')
    core.assertStatus(401)
    const premium = await client
      .post('/api/v1/speech/transcriptions')
      .json({ data: '', format: 'webm' })
    premium.assertStatus(401)
  })

  test('supports projects, backlog, conversations and own provider keys without a subscription', async ({
    client,
  }) => {
    const user = await createFreeUser()
    const project = await client
      .post('/api/v1/projects')
      .loginAs(user)
      .json({ name: 'Free project' })
    project.assertStatus(200)
    const projectId = (project.body() as { data: { id: string } }).data.id
    const story = await client.post('/api/v1/projects/user-stories').loginAs(user).json({
      projectId,
      title: 'Local development',
      summary: 'Uses my own provider',
    })
    story.assertStatus(200)
    const chat = await client.post('/api/v1/projects/quick-chats').loginAs(user).json({
      projectId,
      title: 'Free conversation',
      engineSessionId: 'free-conversation-session',
    })
    chat.assertStatus(200)
    const credential = await client.post('/api/v1/providers/credentials').loginAs(user).json({
      providerId: 'anthropic',
      label: 'Personal',
      apiKey: 'test-personal-provider-key',
    })
    credential.assertStatus(200)
    const own = await client.post('/api/v1/providers/credentials/resolve').loginAs(user).json({
      providerId: 'anthropic',
      label: 'Personal',
    })
    own.assertStatus(200)
    const other = await createFreeUser()
    const privateProject = await client
      .get('/api/v1/projects/' + projectId + '/code-practices')
      .loginAs(other)
    privateProject.assertStatus(404)
  })

  for (const [path, feature] of [
    ['/api/v1/speech/transcriptions', 'speech_transcription'],
    ['/api/v1/preview-sessions', 'cloud_preview'],
    ['/api/v1/preview-sessions/missing/source/import', 'cloud_preview'],
    ['/api/v1/preview-sessions/missing/access-ticket', 'cloud_preview'],
    ['/api/v1/preview-sessions/missing/bridge-grant', 'cloud_preview'],
    ['/api/v1/attachments/uploads', 'cloud_storage'],
    ['/api/v1/projects/missing/deployments', 'cloud_storage'],
    ['/api/v1/projects/missing/deployments/missing/source/complete', 'cloud_storage'],
  ] as const) {
    test('requires Premium before paid work at ' + path, async ({ client }) => {
      const user = await createFreeUser()
      const response = await client.post(path).loginAs(user).json({})
      response.assertStatus(402)
      response.assertBodyContains({ code: 'PREMIUM_REQUIRED', feature })
    })
  }

  test('blocks cloud start and resume commands without a subscription', async ({ client }) => {
    const user = await createFreeUser()
    for (const command of [
      { type: 'start-services', configurationId: 'web' },
      { type: 'start-agent' },
      { type: 'resume-host' },
    ]) {
      const response = await client
        .post('/api/v1/preview-sessions/missing/actions')
        .loginAs(user)
        .json({ command, operationId: randomUUID() })
      response.assertStatus(402)
      response.assertBodyContains({ code: 'PREMIUM_REQUIRED', feature: 'cloud_preview' })
    }
  })

  test('expires paid access while keeping core data available', async ({ client }) => {
    const user = await createLicensedUser()
    const subscription = await UserSubscription.query().where('userId', user.id).firstOrFail()
    subscription.currentPeriodEnd = DateTime.utc().minus({ seconds: 1 })
    await subscription.save()
    const paid = await client
      .post('/api/v1/speech/transcriptions')
      .loginAs(user)
      .json({ data: '', format: 'webm' })
    paid.assertStatus(402)
    const projects = await client.get('/api/v1/projects').loginAs(user)
    projects.assertStatus(200)
  })

  test('allows cloud cleanup and recovery routes without a subscription', async ({ client }) => {
    const user = await createFreeUser()
    const sessionId = randomUUID()
    for (const command of [
      { type: 'stop-services' },
      { type: 'stop-agent' },
      { type: 'suspend-host' },
      { type: 'destroy-host' },
      { type: 'report-sync-conflict', message: 'Needs local recovery' },
      { type: 'ack-local-sync', deltaRevision: 'existing-revision' },
    ]) {
      const response = await client
        .post('/api/v1/preview-sessions/' + sessionId + '/actions')
        .loginAs(user)
        .json({ command, operationId: randomUUID() })
      response.assertStatus(403)
    }
    const exported = await client
      .post('/api/v1/preview-sessions/' + sessionId + '/source/export')
      .loginAs(user)
    exported.assertStatus(403)
  })

  test('keeps Premium until the end of a canceled billing period', async ({ client }) => {
    const user = await createLicensedUser()
    await UserSubscription.query().where('userId', user.id).update({ cancelAtPeriodEnd: true })
    const response = await client
      .post('/api/v1/speech/transcriptions')
      .loginAs(user)
      .json({ data: '', format: 'webm' })
    response.assertStatus(422)
  })

  test('blocks new inline storage through free backlog routes', async ({ client, assert }) => {
    const user = await createFreeUser()
    const project = await client
      .post('/api/v1/projects')
      .loginAs(user)
      .json({ name: 'Free project' })
    const id = randomUUID()
    const response = await client
      .post('/api/v1/projects/user-stories')
      .loginAs(user)
      .json({
        projectId: (project.body() as { data: { id: string } }).data.id,
        title: 'Inline upload',
        summary: 'Should require Premium',
        fileAttachments: [
          { id, content: 'SGVsbG8=', name: 'hello.txt', size: 5, type: 'text/plain' },
        ],
      })
    response.assertStatus(402)
    assert.isNull(await FileAttachment.find(id))
  })

  test('preserves existing file access and references after subscription expiry', async ({
    client,
    assert,
  }) => {
    const user = await createLicensedUser()
    const id = randomUUID()
    const content = Buffer.from('Hello')
    const checksumSha256 = createHash('sha256').update(content).digest('hex')
    const service = new FileAttachmentsService()
    await service.createUpload(user.id, {
      checksumSha256,
      id,
      name: 'hello.txt',
      size: content.length,
      type: 'text/plain',
    })
    await attachmentObjectStorage().put(user.id + '/' + id, content, {
      checksumSha256,
      contentType: 'text/plain',
      size: content.length,
    })
    await UserSubscription.query().where('userId', user.id).delete()
    const completed = await client.post('/api/v1/attachments/' + id + '/complete').loginAs(user)
    completed.assertStatus(200)
    const existing = await client.get('/api/v1/attachments/' + id).loginAs(user)
    existing.assertStatus(200)
    const references = await service.resolveInputs(user.id, [
      { id, name: 'hello.txt', size: content.length, type: 'text/plain' },
    ])
    assert.equal(references[0].id, id)
    const stranger = await createFreeUser()
    const privateFile = await client.get('/api/v1/attachments/' + id).loginAs(stranger)
    privateFile.assertStatus(404)
  })

  test('keeps personal Vercel connection metadata available without a subscription', async ({
    client,
  }) => {
    const user = await createFreeUser()
    const response = await client.get('/api/v1/integrations/vercel/connections').loginAs(user)
    response.assertStatus(200)
    response.assertBodyContains({ connections: [] })
  })
})

function createFreeUser() {
  return User.create({ email: randomUUID() + '@example.com', password: 'password123' })
}
