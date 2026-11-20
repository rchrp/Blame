import EngineSession from '#models/engine_session'
import Project from '#models/project'
import PreviewSession from '#models/preview_session'
import PreviewWorkspaceArtifact from '#models/preview_workspace_artifact'
import User from '#models/user'
import { workspaceArtifactObjectStorage } from '#services/workspace_artifacts/workspace_artifact_object_storage'
import env from '#start/env'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { createLicensedUser as createUser } from '../helpers/create_licensed_user.js'

type AgentModel = { providerId: string; modelId: string; reasoningEffort?: string | null }

type UserStoryData = {
  agentLastError: string | null
  agentModels: AgentModel[] | null
  agentStatus: string | null
  engineSessionId: string | null
  id: string
  storyNumber: number
  priority: string
  status: string
  codeSelectionAttachments?: CodeSelectionAttachment[]
  fileAttachments?: FileAttachment[]
  baseCommit?: string | null
  mergeCommit?: string | null
  runConfigurationId?: string | null
  workspaceMode?: 'local-container' | 'cloud-mirror' | null
  ambition?: 'quick' | 'standard' | 'ambitious' | null
  title: string
}

type UserStoryBody = {
  data: UserStoryData
}

type UserStoryListBody = {
  data: UserStoryData[]
}

type CodeSelectionAttachment = {
  id: string
  content: string
  endLine: number
  path: string
  startLine: number
}

type FileAttachment = {
  id: string
  downloadUrl?: string
  name: string
  size: number
  type: string
}

// What the board reads of a story; the detail adds the story's attachments.
const summaryKeys = [
  'agentLastError',
  'agentModels',
  'agentStatus',
  'ambition',
  'baseCommit',
  'branch',
  'createdAt',
  'discardedReason',
  'engineSessionId',
  'fileAttachmentUploadPending',
  'id',
  'mergeCommit',
  'mergedAt',
  'owner',
  'previewUrl',
  'priority',
  'projectId',
  'pullRequestUrl',
  'runConfigurationId',
  'runMode',
  'status',
  'storyNumber',
  'summary',
  'targetBranch',
  'title',
  'updatedAt',
  'workspaceMode',
  'worktree',
]
const detailKeys = [...summaryKeys, 'codeSelectionAttachments', 'fileAttachments']

test.group('user stories', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('lists stories for one project', async ({ client, assert }) => {
    const user = await createUser()
    const alpha = await createProject(user.id, 'Alpha')
    const beta = await createProject(user.id, 'Beta')

    await client.post('/api/v1/projects/user-stories').loginAs(user).json({
      projectId: alpha.id,
      title: 'Alpha story',
      summary: 'Alpha summary',
    })

    await client.post('/api/v1/projects/user-stories').loginAs(user).json({
      projectId: beta.id,
      title: 'Beta story',
      summary: 'Beta summary',
    })

    const response = await client
      .get('/api/v1/projects/user-stories')
      .qs({ projectId: alpha.id })
      .loginAs(user)

    response.assertStatus(200)
    const body = response.body() as unknown as UserStoryListBody
    assert.lengthOf(body.data, 1)
    assert.equal(body.data[0].title, 'Alpha story')
  })

  test('lists story summaries without detail payloads', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const story = await client
      .post('/api/v1/projects/user-stories')
      .loginAs(user)
      .json({
        projectId: project.id,
        title: 'Large story',
        summary: 'Large summary',
        codeSelectionAttachments: [
          {
            id: 'selection-1',
            content: 'const value = true',
            endLine: 12,
            path: 'src/example.ts',
            startLine: 10,
          },
        ],
      })
    story.assertStatus(200)
    const created = story.body() as unknown as UserStoryBody

    const summaryResponse = await client
      .get('/api/v1/projects/user-stories')
      .qs({ projectId: project.id, view: 'summary' })
      .loginAs(user)

    summaryResponse.assertStatus(200)
    const summary = summaryResponse.body() as unknown as UserStoryListBody
    assert.equal(summary.data[0].title, 'Large story')
    assert.sameMembers(Object.keys(summary.data[0]), summaryKeys)

    const listResponse = await client
      .get('/api/v1/projects/user-stories')
      .qs({ projectId: project.id })
      .loginAs(user)

    listResponse.assertStatus(200)
    const list = listResponse.body() as unknown as UserStoryListBody
    assert.sameMembers(Object.keys(list.data[0]), detailKeys)

    const detailResponse = await client
      .get(`/api/v1/projects/user-stories/${created.data.id}`)
      .loginAs(user)

    detailResponse.assertStatus(200)
    const detail = detailResponse.body() as unknown as UserStoryBody
    assert.sameMembers(Object.keys(detail.data), detailKeys)
    assert.lengthOf(detail.data.codeSelectionAttachments ?? [], 1)
    assert.lengthOf(detail.data.fileAttachments ?? [], 0)
  })

  test('keeps the ambition chosen for a story, and clears it', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')

    const createdResponse = await client.post('/api/v1/projects/user-stories').loginAs(user).json({
      projectId: project.id,
      title: 'Go deep',
      summary: 'Ambitious work',
      ambition: 'ambitious',
    })
    const created = createdResponse.body() as UserStoryBody
    assert.equal(created.data.ambition, 'ambitious')

    const withoutAmbitionResponse = await client
      .post('/api/v1/projects/user-stories')
      .loginAs(user)
      .json({ projectId: project.id, title: 'Default', summary: 'Follows the account' })
    const withoutAmbition = withoutAmbitionResponse.body() as UserStoryBody
    assert.isNull(withoutAmbition.data.ambition)

    const updated = await client
      .patch(`/api/v1/projects/user-stories/${created.data.id}`)
      .loginAs(user)
      .json({ ambition: 'quick' })
    updated.assertStatus(200)
    assert.equal((updated.body() as UserStoryBody).data.ambition, 'quick')

    const cleared = await client
      .patch(`/api/v1/projects/user-stories/${created.data.id}`)
      .loginAs(user)
      .json({ ambition: null })
    assert.isNull((cleared.body() as UserStoryBody).data.ambition)

    const shown = await client.get(`/api/v1/projects/user-stories/${created.data.id}`).loginAs(user)
    assert.isNull((shown.body() as UserStoryBody).data.ambition)
  })

  test('rejects an unknown story ambition', async ({ client }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')

    const response = await client
      .post('/api/v1/projects/user-stories')
      .loginAs(user)
      .json({ projectId: project.id, title: 'Too much', summary: 'Invalid', ambition: 'reckless' })

    response.assertStatus(422)
  })

  test('creates updates and deletes a story', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')

    const createResponse = await client
      .post('/api/v1/projects/user-stories')
      .loginAs(user)
      .json({
        projectId: project.id,
        runConfigurationId: 'web-app',
        workspaceMode: 'local-container',
        title: 'Persist draft',
        summary: 'Initial summary',
        codeSelectionAttachments: [
          {
            id: 'selection-1',
            content: 'const value = true',
            endLine: 12,
            path: 'src/example.ts',
            startLine: 10,
          },
        ],
        fileAttachments: [
          {
            id: 'file-1',
            content: 'SGVsbG8=',
            name: 'hello.txt',
            size: 5,
            type: 'text/plain',
          },
        ],
      })

    createResponse.assertStatus(200)
    const created = createResponse.body() as unknown as UserStoryBody
    assert.equal(created.data.status, 'backlog')
    assert.equal(created.data.priority, 'Medium')
    assert.equal(created.data.runConfigurationId, 'web-app')
    assert.equal(created.data.workspaceMode, 'local-container')
    assert.deepEqual(created.data.codeSelectionAttachments, [
      {
        id: 'selection-1',
        content: 'const value = true',
        endLine: 12,
        path: 'src/example.ts',
        startLine: 10,
      },
    ])
    assert.deepInclude(created.data.fileAttachments?.[0], {
      id: 'file-1',
      name: 'hello.txt',
      size: 5,
      type: 'text/plain',
    })
    assert.match(created.data.fileAttachments?.[0]?.downloadUrl ?? '', /^memory:/)
    assert.notProperty(created.data.fileAttachments?.[0] ?? {}, 'content')

    const updateResponse = await client
      .patch(`/api/v1/projects/user-stories/${created.data.id}`)
      .loginAs(user)
      .json({
        title: 'Persisted draft',
        status: 'ready',
        priority: 'High',
        runConfigurationId: 'admin-app',
        workspaceMode: 'cloud-mirror',
        baseCommit: '1111111111111111111111111111111111111111',
        mergeCommit: '2222222222222222222222222222222222222222',
        codeSelectionAttachments: [
          {
            id: 'selection-2',
            content: 'return value',
            endLine: 22,
            path: 'src/updated.ts',
            startLine: 20,
          },
        ],
        fileAttachments: [
          {
            id: 'file-2',
            content: 'VXBkYXRlZA==',
            name: 'updated.txt',
            size: 7,
            type: 'text/plain',
          },
        ],
      })

    updateResponse.assertStatus(200)
    const updated = updateResponse.body() as UserStoryBody
    assert.equal(updated.data.title, 'Persisted draft')
    assert.equal(updated.data.status, 'ready')
    assert.equal(updated.data.priority, 'High')
    assert.equal(updated.data.runConfigurationId, 'admin-app')
    assert.equal(updated.data.workspaceMode, 'cloud-mirror')
    assert.equal(updated.data.baseCommit, '1111111111111111111111111111111111111111')
    assert.equal(updated.data.mergeCommit, '2222222222222222222222222222222222222222')
    assert.deepEqual(updated.data.codeSelectionAttachments, [
      {
        id: 'selection-2',
        content: 'return value',
        endLine: 22,
        path: 'src/updated.ts',
        startLine: 20,
      },
    ])
    assert.deepInclude(updated.data.fileAttachments?.[0], {
      id: 'file-2',
      name: 'updated.txt',
      size: 7,
      type: 'text/plain',
    })
    assert.match(updated.data.fileAttachments?.[0]?.downloadUrl ?? '', /^memory:/)
    assert.notProperty(updated.data.fileAttachments?.[0] ?? {}, 'content')

    const showResponse = await client
      .get(`/api/v1/projects/user-stories/${created.data.id}`)
      .loginAs(user)

    showResponse.assertStatus(200)
    const shown = showResponse.body() as UserStoryBody
    assert.equal(shown.data.id, created.data.id)
    assert.equal(shown.data.runConfigurationId, 'admin-app')
    assert.equal(shown.data.workspaceMode, 'cloud-mirror')

    const previewSessionId = 'preview_delete_cleanup'
    await PreviewSession.create({
      id: previewSessionId,
      userStoryId: created.data.id,
      ownerUserId: user.id,
      profile: 'vercel-compose',
      desired: JSON.stringify({
        host: 'suspended',
        services: 'stopped',
        preview: 'closed',
        agent: 'idle',
      }),
      state: JSON.stringify({
        host: 'suspended',
        engine: 'stopped',
        preview: 'closed',
        agent: 'idle',
        sync: 'clean',
      }),
      revision: 0,
      generation: 0,
      fencingToken: 0,
      providerHandleEncrypted: null,
      plan: '{}',
      planHash: '0'.repeat(64),
      planVersion: 1,
      protocolVersion: null,
      runnerVersion: null,
      imageDigest: null,
      sourceRevision: null,
      sourceArtifactId: null,
      baselineId: null,
      lastExportedJournalRevision: null,
      lastAppliedLocalRevision: null,
      lastAcknowledgedRemoteRevision: null,
      pendingDeltaArtifactId: null,
      endpointMapEncrypted: null,
      resourceVcpus: 2,
      resourceMemoryGb: 4,
      failure: null,
      selection: null,
      lastActivityAt: DateTime.utc(),
      stateChangedAt: DateTime.utc(),
      leaseExpiresAt: null,
      idleDeadlineAt: null,
      stoppedAt: DateTime.utc(),
      createdAt: DateTime.utc(),
    })
    const artifactObjectKey = `${previewSessionId}/delete-cleanup.tar.gz`
    const artifact = await PreviewWorkspaceArtifact.create({
      sessionId: previewSessionId,
      kind: 'source',
      mode: 'full',
      status: 'durable',
      objectKey: artifactObjectKey,
      sha256: 'a'.repeat(64),
      size: 1,
      sourceRevision: 'source',
      sanitizedTreeHash: null,
      lockfileHash: null,
      workspaceHash: null,
      baseHash: null,
      finalHash: null,
      generation: null,
      durableAt: DateTime.utc(),
      appliedAt: null,
      discardedAt: null,
      expiresAt: DateTime.utc().plus({ hours: 1 }),
    })
    const artifactStorage = workspaceArtifactObjectStorage()
    await artifactStorage.put(artifactObjectKey, new Uint8Array([1]), {
      checksumSha256: 'a'.repeat(64),
      contentType: 'application/gzip',
      encryptionScope: previewSessionId,
      serverSideEncryption: 'AES256',
      size: 1,
    })

    const previewLookup = await client
      .get('/api/v1/preview-sessions')
      .qs({ userStoryId: created.data.id, profile: 'vercel-compose' })
      .loginAs(user)

    previewLookup.assertStatus(200)
    assert.equal(
      (previewLookup.body() as unknown as { session: { id: string } }).session.id,
      previewSessionId
    )

    const deleteResponse = await client
      .delete(`/api/v1/projects/user-stories/${created.data.id}`)
      .loginAs(user)

    deleteResponse.assertStatus(204)
    assert.isNull(await PreviewSession.find(previewSessionId))
    assert.isNull(await PreviewWorkspaceArtifact.find(artifact.id))
    await assert.rejects(() => artifactStorage.content(artifactObjectKey))

    const listResponse = await client
      .get('/api/v1/projects/user-stories')
      .qs({ projectId: project.id })
      .loginAs(user)

    listResponse.assertStatus(200)
    const list = listResponse.body() as unknown as UserStoryListBody
    assert.lengthOf(list.data, 0)
  })

  test('names its engine session and reports its agent', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const story = await createStory(client, user, project.id)
    assert.isNull(story.data.engineSessionId)
    assert.isNull(story.data.agentStatus)
    assert.isNull(story.data.agentModels)
    const engineSessionId = sessionId()
    const agentModels = [
      { providerId: 'anthropic', modelId: 'claude-opus', reasoningEffort: 'high' },
      { providerId: 'openai', modelId: 'gpt-large' },
    ]

    const started = await client
      .patch(`/api/v1/projects/user-stories/${story.data.id}`)
      .loginAs(user)
      .json({
        status: 'in-progress',
        engineSessionId,
        agentStatus: 'Running',
        agentLastError: 'The provider was unavailable',
        agentModels,
        // Fields of the Cline runtime are no longer part of a story.
        clineSessionId: 'cline-session',
        agentActivities: [],
      })

    started.assertStatus(200)
    const body = started.body() as UserStoryBody
    assert.sameMembers(Object.keys(body.data), detailKeys)
    assert.equal(body.data.engineSessionId, engineSessionId)
    assert.equal(body.data.agentStatus, 'Running')
    assert.equal(body.data.agentLastError, 'The provider was unavailable')
    assert.deepEqual(body.data.agentModels, agentModels)

    // The same story may name its own session again.
    const paused = await client
      .patch(`/api/v1/projects/user-stories/${story.data.id}`)
      .loginAs(user)
      .json({ engineSessionId, agentStatus: 'Paused', agentLastError: null })
    paused.assertStatus(200)

    const summary = await listStories(client, user, project.id, 'summary')
    assert.equal(summary[0].engineSessionId, engineSessionId)
    assert.equal(summary[0].agentStatus, 'Paused')
    assert.isNull(summary[0].agentLastError)
    assert.deepEqual(summary[0].agentModels, agentModels)

    const cleared = await client
      .patch(`/api/v1/projects/user-stories/${story.data.id}`)
      .loginAs(user)
      .json({ agentModels: null })
    assert.isNull((cleared.body() as UserStoryBody).data.agentModels)
  })

  test('clears the agent status when the story leaves progress', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const story = await createStory(client, user, project.id)
    const path = `/api/v1/projects/user-stories/${story.data.id}`

    await client.patch(path).loginAs(user).json({ status: 'in-progress', agentStatus: 'Running' })
    const renamed = await client.patch(path).loginAs(user).json({ title: 'Still running' })
    assert.equal((renamed.body() as UserStoryBody).data.agentStatus, 'Running')

    const reviewed = await client.patch(path).loginAs(user).json({ status: 'in-review' })
    reviewed.assertStatus(200)
    assert.equal((reviewed.body() as UserStoryBody).data.status, 'in-review')
    assert.isNull((reviewed.body() as UserStoryBody).data.agentStatus)
  })

  test('validates the models that worked on a story', async ({ client }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const story = await createStory(client, user, project.id)
    const path = `/api/v1/projects/user-stories/${story.data.id}`
    const model = { providerId: 'anthropic', modelId: 'claude-opus' }

    for (const agentModels of [
      Array.from({ length: 17 }, () => model),
      [{ providerId: 'anthropic' }],
      [{ providerId: '', modelId: 'claude-opus' }],
      [{ ...model, reasoningEffort: 'x'.repeat(33) }],
      'claude-opus',
    ]) {
      const response = await client.patch(path).loginAs(user).json({ agentModels })
      response.assertStatus(422)
    }
    const response = await client
      .patch(path)
      .loginAs(user)
      .json({ agentModels: Array.from({ length: 16 }, () => model) })
    response.assertStatus(200)
  })

  test('refuses an engine session id that is invalid, taken or of another account', async ({
    assert,
    client,
  }) => {
    const user = await createUser()
    const stranger = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const first = await createStory(client, user, project.id)
    const second = await createStory(client, user, project.id)
    const engineSessionId = sessionId()
    const named = await client
      .patch(`/api/v1/projects/user-stories/${first.data.id}`)
      .loginAs(user)
      .json({ engineSessionId })
    named.assertStatus(200)
    const foreignSession = sessionId()
    assert.equal(await pushRecords(stranger, foreignSession), 200)

    const path = `/api/v1/projects/user-stories/${second.data.id}`
    for (const invalid of ['has space', 'x'.repeat(65), 'é', engineSessionId]) {
      const response = await client.patch(path).loginAs(user).json({ engineSessionId: invalid })
      response.assertStatus(422)
    }
    const foreign = await client.patch(path).loginAs(user).json({ engineSessionId: foreignSession })
    foreign.assertStatus(403)
    const shown = await client.get(path).loginAs(user)
    assert.isNull((shown.body() as UserStoryBody).data.engineSessionId)
  })

  test('deleting a story deletes its engine session', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const pushed = await createStory(client, user, project.id)
    const unpushed = await createStory(client, user, project.id)
    const pushedSession = sessionId()
    await nameSession(client, user, pushed.data.id, pushedSession)
    await nameSession(client, user, unpushed.data.id, sessionId())
    assert.equal(await pushRecords(user, pushedSession), 200)

    const response = await client
      .delete(`/api/v1/projects/user-stories/${pushed.data.id}`)
      .loginAs(user)
    response.assertStatus(204)
    assert.isNull(await EngineSession.find(pushedSession))
    const records = await db.from('engine_session_records').where('session_id', pushedSession)
    assert.lengthOf(records, 0)

    const second = await client
      .delete(`/api/v1/projects/user-stories/${unpushed.data.id}`)
      .loginAs(user)
    second.assertStatus(204)
    assert.lengthOf(await listStories(client, user, project.id), 0)
  })

  test("another user's story is not found", async ({ client, assert }) => {
    const owner = await createUser()
    const stranger = await createUser()
    const project = await createProject(owner.id, 'Private')
    const story = await createStory(client, owner, project.id)
    const engineSessionId = sessionId()
    await nameSession(client, owner, story.data.id, engineSessionId)
    assert.equal(await pushRecords(owner, engineSessionId), 200)

    const path = `/api/v1/projects/user-stories/${story.data.id}`
    const shown = await client.get(path).loginAs(stranger)
    shown.assertStatus(404)
    const updated = await client
      .patch(path)
      .loginAs(stranger)
      .json({ title: 'Taken', agentStatus: 'Running' })
    updated.assertStatus(404)
    const deleted = await client.delete(path).loginAs(stranger)
    deleted.assertStatus(404)
    const listed = await client
      .get('/api/v1/projects/user-stories')
      .qs({ projectId: project.id })
      .loginAs(stranger)
    listed.assertStatus(404)

    assert.isNotNull(await EngineSession.find(engineSessionId))
    const owned = await client.get(path).loginAs(owner)
    assert.equal((owned.body() as UserStoryBody).data.title, 'Reviewable story')
    assert.isNull((owned.body() as UserStoryBody).data.agentStatus)
  })
})

async function createStory(client: ApiClient, user: User, projectId: string) {
  const response = await client.post('/api/v1/projects/user-stories').loginAs(user).json({
    projectId,
    title: 'Reviewable story',
    summary: 'Initial summary',
  })

  response.assertStatus(200)
  return response.body() as unknown as UserStoryBody
}

async function nameSession(
  client: ApiClient,
  user: User,
  storyId: string,
  engineSessionId: string
) {
  const response = await client
    .patch(`/api/v1/projects/user-stories/${storyId}`)
    .loginAs(user)
    .json({ engineSessionId })
  response.assertStatus(200)
}

async function listStories(client: ApiClient, user: User, projectId: string, view?: 'summary') {
  const response = await client
    .get('/api/v1/projects/user-stories')
    .qs(view ? { projectId, view } : { projectId })
    .loginAs(user)
  response.assertStatus(200)
  return (response.body() as UserStoryListBody).data
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
            config: { purpose: 'story', workspace_root: '/work' },
          },
        ],
      }),
    }
  )
  return response.status
}

function sessionId() {
  return `story-${randomUUID()}`
}

function createProject(userId: string, name: string) {
  return Project.create({
    name,
    repositoryFingerprint: randomUUID(),
    userId,
  })
}
