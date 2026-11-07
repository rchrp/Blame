import Project from '#models/project'
import PreviewSession from '#models/preview_session'
import PreviewWorkspaceArtifact from '#models/preview_workspace_artifact'
import { persistUserStoryRunActivity, userStoryRunActivity } from '#services/agent_run_activity_log'
import { workspaceArtifactObjectStorage } from '#services/workspace_artifacts/workspace_artifact_object_storage'
import testUtils from '@adonisjs/core/services/test_utils'
import { DateTime } from 'luxon'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { createLicensedUser as createUser } from '../helpers/create_licensed_user.js'

type UserStoryBody = {
  data: {
    comments?: UserStoryCommentBody['data'][]
    agentRuns?: UserStoryAgentRunBody['data'][]
    runningAgentRuns?: UserStoryAgentRunBody['data'][]
    agentActivities?: {
      detail: string
      detailArtifact?: string
      id: string
      originalDetailLength?: number
      status?: string
    }[]
    activeAgentRunId?: string | null
    agentFinalResponse?: string | null
    agentStatus?: string | null
    agentUsage?: {
      inputTokens: number
      totalInputTokens: number
    }
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
}

type UserStoryListBody = {
  data: UserStoryBody['data'][]
}

type UserStoryCommentBody = {
  data: {
    author: string
    body: string
    codeSelectionAttachments?: CodeSelectionAttachment[]
    fileAttachments?: FileAttachment[]
    id: string
    userStoryId: string
  }
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

type UserStoryAgentRunBody = {
  data: {
    activities?: {
      detail: string
      detailArtifact?: string
      id: string
      originalDetailLength?: number
      status?: string
    }[]
    commentId?: string | null
    completedAt?: string | null
    executionId?: string | null
    finalResponse?: string | null
    id: string
    kind: string
    status: string
    userStoryId: string
    usage?: {
      inputTokens: number
      totalInputTokens: number
    } | null
  }
}

type AgentActivityDetailBody = {
  detail: string
}

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
    const created = story.body() as unknown as UserStoryBody

    await client
      .post(`/api/v1/projects/user-stories/${created.data.id}/comments`)
      .loginAs(user)
      .json({ body: 'Feedback' })
    await client
      .post(`/api/v1/projects/user-stories/${created.data.id}/agent-runs`)
      .loginAs(user)
      .json({ kind: 'initial' })

    const summaryResponse = await client
      .get('/api/v1/projects/user-stories')
      .qs({ projectId: project.id, view: 'summary' })
      .loginAs(user)

    summaryResponse.assertStatus(200)
    const summary = summaryResponse.body() as unknown as UserStoryListBody
    assert.equal(summary.data[0].title, 'Large story')
    assert.isUndefined(summary.data[0].codeSelectionAttachments)
    assert.isUndefined(summary.data[0].fileAttachments)
    assert.isUndefined(summary.data[0].comments)
    assert.isUndefined(summary.data[0].agentRuns)
    assert.lengthOf(summary.data[0].runningAgentRuns ?? [], 1)

    const detailResponse = await client
      .get(`/api/v1/projects/user-stories/${created.data.id}`)
      .loginAs(user)

    detailResponse.assertStatus(200)
    const detail = detailResponse.body() as unknown as UserStoryBody
    assert.lengthOf(detail.data.codeSelectionAttachments ?? [], 1)
    assert.lengthOf(detail.data.fileAttachments ?? [], 1)
    assert.lengthOf(detail.data.comments ?? [], 1)
    assert.lengthOf(detail.data.agentRuns ?? [], 1)
  })

  test('keeps the ambition chosen for a story, and clears it', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')

    const created = (
      await client
        .post('/api/v1/projects/user-stories')
        .loginAs(user)
        .json({ projectId: project.id, title: 'Go deep', summary: 'Ambitious work', ambition: 'ambitious' })
    ).body() as UserStoryBody
    assert.equal(created.data.ambition, 'ambitious')

    const withoutAmbition = (
      await client
        .post('/api/v1/projects/user-stories')
        .loginAs(user)
        .json({ projectId: project.id, title: 'Default', summary: 'Follows the account' })
    ).body() as UserStoryBody
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

    const shown = await client
      .get(`/api/v1/projects/user-stories/${created.data.id}`)
      .loginAs(user)
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

  test('creates and lists story comments in order', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const story = await createStory(client, user, project.id)

    const firstResponse = await client
      .post(`/api/v1/projects/user-stories/${story.data.id}/comments`)
      .loginAs(user)
      .json({
        body: 'First feedback',
        codeSelectionAttachments: [
          {
            id: 'comment-selection-1',
            content: 'displayComment()',
            endLine: 4,
            path: 'src/comment.ts',
            startLine: 4,
          },
        ],
        fileAttachments: [
          {
            id: 'comment-file-1',
            content: 'Y29tbWVudA==',
            name: 'comment.txt',
            size: 7,
            type: 'text/plain',
          },
        ],
      })

    firstResponse.assertStatus(200)
    const first = firstResponse.body() as UserStoryCommentBody
    assert.equal(first.data.body, 'First feedback')
    assert.equal(first.data.author, 'Product')
    assert.equal(first.data.userStoryId, story.data.id)
    assert.deepEqual(first.data.codeSelectionAttachments, [
      {
        id: 'comment-selection-1',
        content: 'displayComment()',
        endLine: 4,
        path: 'src/comment.ts',
        startLine: 4,
      },
    ])
    assert.deepInclude(first.data.fileAttachments?.[0], {
      id: 'comment-file-1',
      name: 'comment.txt',
      size: 7,
      type: 'text/plain',
    })
    assert.match(first.data.fileAttachments?.[0]?.downloadUrl ?? '', /^memory:/)
    assert.notProperty(first.data.fileAttachments?.[0] ?? {}, 'content')

    await client
      .post(`/api/v1/projects/user-stories/${story.data.id}/comments`)
      .loginAs(user)
      .json({ body: 'Second feedback' })

    const showResponse = await client
      .get(`/api/v1/projects/user-stories/${story.data.id}`)
      .loginAs(user)

    showResponse.assertStatus(200)
    const shown = showResponse.body() as UserStoryBody
    assert.deepEqual(
      shown.data.comments?.map((comment) => comment.body),
      ['First feedback', 'Second feedback']
    )

    const listResponse = await client
      .get('/api/v1/projects/user-stories')
      .qs({ projectId: project.id })
      .loginAs(user)

    listResponse.assertStatus(200)
    const list = listResponse.body() as unknown as UserStoryListBody
    assert.deepEqual(
      list.data[0].comments?.map((comment) => comment.body),
      ['First feedback', 'Second feedback']
    )
  })

  test('rejects blank story comments', async ({ client }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const story = await createStory(client, user, project.id)

    const response = await client
      .post(`/api/v1/projects/user-stories/${story.data.id}/comments`)
      .loginAs(user)
      .json({ body: '   ' })

    response.assertStatus(422)
  })

  test('prevents commenting on another users story', async ({ client }) => {
    const owner = await createUser()
    const stranger = await createUser()
    const project = await createProject(owner.id, 'Alpha')
    const story = await createStory(client, owner, project.id)

    const response = await client
      .post(`/api/v1/projects/user-stories/${story.data.id}/comments`)
      .loginAs(stranger)
      .json({ body: 'Unauthorized feedback' })

    response.assertStatus(404)
  })

  test('creates updates and lists story agent runs in order', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const story = await createStory(client, user, project.id)
    const commentResponse = await client
      .post(`/api/v1/projects/user-stories/${story.data.id}/comments`)
      .loginAs(user)
      .json({ body: 'Please adjust the layout' })
    const comment = commentResponse.body() as UserStoryCommentBody
    const worktree = await mkdtemp(join(tmpdir(), 'blame-story-run-'))
    const detail = `Run command\n${'y'.repeat(7000)}`

    try {
      await client
        .patch(`/api/v1/projects/user-stories/${story.data.id}`)
        .loginAs(user)
        .json({ worktree })

      const initialResponse = await client
        .post(`/api/v1/projects/user-stories/${story.data.id}/agent-runs`)
        .loginAs(user)
        .json({
          clineSessionId: 'initial-session',
          kind: 'initial',
        })

      initialResponse.assertStatus(200)
      const initialRun = initialResponse.body() as UserStoryAgentRunBody
      assert.equal(initialRun.data.kind, 'initial')
      assert.equal(initialRun.data.status, 'running')

      const changeResponse = await client
        .post(`/api/v1/projects/user-stories/${story.data.id}/agent-runs`)
        .loginAs(user)
        .json({
          clineSessionId: 'change-session',
          commentId: comment.data.id,
          kind: 'change-request',
        })

      changeResponse.assertStatus(200)
      const changeRun = changeResponse.body() as UserStoryAgentRunBody
      assert.equal(changeRun.data.commentId, comment.data.id)

      const updateResponse = await client
        .patch(`/api/v1/projects/user-stories/${story.data.id}/agent-runs/${changeRun.data.id}`)
        .loginAs(user)
        .json({
          agentActivity: {
            createdAt: new Date().toISOString(),
            detail,
            id: 'tool-run-command',
            kind: 'tool',
            status: 'completed',
            title: 'Ran command',
          },
          finalResponse: 'Updated implementation.',
          status: 'completed',
          usage: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0.01,
            inputTokens: 1000,
            outputTokens: 100,
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            totalCost: 0.01,
            totalInputTokens: 1000,
            totalOutputTokens: 100,
          },
        })

      updateResponse.assertStatus(200)
      const updated = updateResponse.body() as UserStoryAgentRunBody
      assert.equal(updated.data.status, 'completed')
      assert.equal(updated.data.finalResponse, 'Updated implementation.')
      assert.lengthOf(updated.data.activities ?? [], 1)
      assert.isBelow(updated.data.activities?.[0]?.detail.length ?? 0, detail.length)
      assert.equal(updated.data.activities?.[0]?.originalDetailLength, detail.length)
      assert.include(updated.data.activities?.[0]?.detailArtifact ?? '', 'change-session')
      assert.equal(updated.data.usage?.inputTokens, 1000)

      const detailResponse = await client
        .get(
          `/api/v1/projects/user-stories/${story.data.id}/agent-runs/${changeRun.data.id}/activities/tool-run-command`
        )
        .loginAs(user)

      detailResponse.assertStatus(200)
      assert.equal((detailResponse.body() as AgentActivityDetailBody).detail, detail)

      const showResponse = await client
        .get(`/api/v1/projects/user-stories/${story.data.id}`)
        .loginAs(user)

      showResponse.assertStatus(200)
      const shown = showResponse.body() as UserStoryBody
      assert.deepEqual(
        shown.data.agentRuns?.map((run) => run.kind),
        ['initial', 'change-request']
      )

      const listResponse = await client
        .get('/api/v1/projects/user-stories')
        .qs({ projectId: project.id })
        .loginAs(user)

      listResponse.assertStatus(200)
      const list = listResponse.body() as unknown as UserStoryListBody
      assert.deepEqual(
        list.data[0].agentRuns?.map((run) => run.kind),
        ['initial', 'change-request']
      )
    } finally {
      await rm(worktree, { force: true, recursive: true })
    }
  })

  test('prevents accessing another users story agent runs', async ({ client }) => {
    const owner = await createUser()
    const stranger = await createUser()
    const project = await createProject(owner.id, 'Alpha')
    const story = await createStory(client, owner, project.id)
    const runResponse = await client
      .post(`/api/v1/projects/user-stories/${story.data.id}/agent-runs`)
      .loginAs(owner)
      .json({ kind: 'initial' })
    const run = runResponse.body() as UserStoryAgentRunBody

    const updateResponse = await client
      .patch(`/api/v1/projects/user-stories/${story.data.id}/agent-runs/${run.data.id}`)
      .loginAs(stranger)
      .json({ status: 'completed' })

    updateResponse.assertStatus(404)

    const detailResponse = await client
      .get(
        `/api/v1/projects/user-stories/${story.data.id}/agent-runs/${run.data.id}/activities/missing`
      )
      .loginAs(stranger)

    detailResponse.assertStatus(404)
  })

  test('finalizes only the active agent run and remains idempotent', async ({ assert, client }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const story = await createStory(client, user, project.id)
    const firstResponse = await client
      .post(`/api/v1/projects/user-stories/${story.data.id}/agent-runs`)
      .loginAs(user)
      .json({ executionId: crypto.randomUUID(), kind: 'initial' })
    const firstRun = (firstResponse.body() as UserStoryAgentRunBody).data
    const secondResponse = await client
      .post(`/api/v1/projects/user-stories/${story.data.id}/agent-runs`)
      .loginAs(user)
      .json({ executionId: crypto.randomUUID(), kind: 'resume' })
    const secondRun = (secondResponse.body() as UserStoryAgentRunBody).data

    const staleFinalization = await finalizeRun(client, user, story.data.id, firstRun.id, {
      finalResponse: 'Stale response',
      status: 'completed',
    })

    staleFinalization.assertStatus(200)
    const afterStale = staleFinalization.body() as UserStoryBody
    assert.equal(afterStale.data.activeAgentRunId, secondRun.id)
    assert.equal(afterStale.data.agentFinalResponse, null)
    assert.equal(afterStale.data.agentStatus, 'Running')
    assert.equal(afterStale.data.status, 'in-progress')
    assert.equal(
      afterStale.data.agentRuns?.find((run) => run.id === firstRun.id)?.status,
      'completed'
    )

    const activeFinalization = await finalizeRun(client, user, story.data.id, secondRun.id, {
      finalResponse: 'Current response',
      status: 'completed',
    })
    const completed = activeFinalization.body() as UserStoryBody

    activeFinalization.assertStatus(200)
    assert.equal(completed.data.activeAgentRunId, null)
    assert.equal(completed.data.agentFinalResponse, 'Current response')
    assert.equal(completed.data.agentStatus, null)
    assert.equal(completed.data.status, 'in-review')
    assert.equal(
      completed.data.agentRuns?.find((run) => run.id === secondRun.id)?.status,
      'completed'
    )

    const duplicate = await finalizeRun(client, user, story.data.id, secondRun.id, {
      finalResponse: 'Replacement response',
      status: 'failed',
    })
    const afterDuplicate = duplicate.body() as UserStoryBody

    duplicate.assertStatus(200)
    assert.equal(afterDuplicate.data.agentFinalResponse, 'Current response')
    assert.equal(
      afterDuplicate.data.agentRuns?.find((run) => run.id === secondRun.id)?.status,
      'completed'
    )

    const regression = await client
      .patch(`/api/v1/projects/user-stories/${story.data.id}/agent-runs/${secondRun.id}`)
      .loginAs(user)
      .json({ status: 'running' })
    const monotonicRun = regression.body() as UserStoryAgentRunBody

    regression.assertStatus(200)
    assert.equal(monotonicRun.data.status, 'completed')
  })

  test('cancels the active run when a running story is discarded', async ({ assert, client }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const story = await createStory(client, user, project.id)
    const runResponse = await client
      .post(`/api/v1/projects/user-stories/${story.data.id}/agent-runs`)
      .loginAs(user)
      .json({ executionId: crypto.randomUUID(), kind: 'initial' })
    const run = (runResponse.body() as UserStoryAgentRunBody).data
    const reasoningActivity = {
      createdAt: new Date().toISOString(),
      detail: 'Inspecting the harness',
      id: 'reasoning-36-1',
      kind: 'reasoning',
      status: 'running',
      title: 'Reasoning',
    }
    const toolActivity = {
      createdAt: new Date().toISOString(),
      detail: 'Running the final build',
      id: 'tool-call-final-build',
      kind: 'tool' as const,
      status: 'running' as const,
      title: 'run_task',
    }

    const activityResponse = await client
      .patch(`/api/v1/projects/user-stories/${story.data.id}/agent-runs/${run.id}`)
      .loginAs(user)
      .json({ agentActivity: reasoningActivity })
    activityResponse.assertStatus(200)
    const storyActivityResponse = await client
      .patch(`/api/v1/projects/user-stories/${story.data.id}`)
      .loginAs(user)
      .json({ agentActivity: reasoningActivity })
    storyActivityResponse.assertStatus(200)
    await persistUserStoryRunActivity(run.id, toolActivity)

    const discardedResponse = await client
      .patch(`/api/v1/projects/user-stories/${story.data.id}`)
      .loginAs(user)
      .json({ status: 'discarded' })
    const discarded = discardedResponse.body() as UserStoryBody
    const cancelled = discarded.data.agentRuns?.find(({ id }) => id === run.id)

    discardedResponse.assertStatus(200)
    assert.equal(discarded.data.activeAgentRunId, null)
    assert.equal(discarded.data.agentStatus, null)
    assert.equal(cancelled?.status, 'cancelled')
    assert.isNotNull(cancelled?.completedAt)
    assert.equal(
      cancelled?.activities?.find(({ id }) => id === 'reasoning-36-1')?.status,
      'completed'
    )
    assert.equal(
      cancelled?.activities?.find(({ id }) => id === 'tool-call-final-build')?.status,
      'failed'
    )
    const persistedToolActivity = await userStoryRunActivity(run.id, toolActivity.id)
    assert.equal(persistedToolActivity?.status, 'failed')
    assert.equal(
      discarded.data.agentActivities?.find(({ id }) => id === 'reasoning-36-1')?.status,
      'completed'
    )

    const lateRunResponse = await client
      .patch(`/api/v1/projects/user-stories/${story.data.id}/agent-runs/${run.id}`)
      .loginAs(user)
      .json({ agentActivity: reasoningActivity })
    const lateRun = (lateRunResponse.body() as UserStoryAgentRunBody).data
    lateRunResponse.assertStatus(200)
    assert.equal(lateRun.activities?.find(({ id }) => id === 'reasoning-36-1')?.status, 'completed')

    const lateStoryResponse = await client
      .patch(`/api/v1/projects/user-stories/${story.data.id}`)
      .loginAs(user)
      .json({ agentActivity: reasoningActivity })
    const lateStory = (lateStoryResponse.body() as UserStoryBody).data
    lateStoryResponse.assertStatus(200)
    assert.equal(
      lateStory.agentActivities?.find(({ id }) => id === 'reasoning-36-1')?.status,
      'completed'
    )
  })

  test('deletes a story while its agent run is active', async ({ client }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const story = await createStory(client, user, project.id)
    const runResponse = await client
      .post(`/api/v1/projects/user-stories/${story.data.id}/agent-runs`)
      .loginAs(user)
      .json({ executionId: crypto.randomUUID(), kind: 'initial' })

    runResponse.assertStatus(200)
    const response = await client
      .delete(`/api/v1/projects/user-stories/${story.data.id}`)
      .loginAs(user)

    response.assertStatus(204)
  })

  test('merges agent activity deltas and serves large details lazily', async ({
    assert,
    client,
  }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const story = await createStory(client, user, project.id)
    const worktree = await mkdtemp(join(tmpdir(), 'blame-story-'))
    const detail = `Read files\n${'x'.repeat(7000)}`

    try {
      await client
        .patch(`/api/v1/projects/user-stories/${story.data.id}`)
        .loginAs(user)
        .json({ clineSessionId: 'session-1', worktree })

      const updateResponse = await client
        .patch(`/api/v1/projects/user-stories/${story.data.id}`)
        .loginAs(user)
        .json({
          agentActivity: {
            createdAt: new Date().toISOString(),
            detail,
            id: 'tool-large-read',
            kind: 'tool',
            status: 'completed',
            title: 'Read files',
          },
          agentUsage: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0.01,
            inputTokens: 1000,
            outputTokens: 100,
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            totalCost: 0.01,
            totalInputTokens: 1000,
            totalOutputTokens: 100,
          },
        })

      updateResponse.assertStatus(200)
      const updated = updateResponse.body() as UserStoryBody
      assert.lengthOf(updated.data.agentActivities ?? [], 1)
      assert.isBelow(updated.data.agentActivities?.[0]?.detail.length ?? 0, detail.length)
      assert.equal(updated.data.agentActivities?.[0]?.originalDetailLength, detail.length)
      assert.include(updated.data.agentActivities?.[0]?.detailArtifact ?? '', 'session-1')
      assert.equal(updated.data.agentUsage?.inputTokens, 1000)

      const detailResponse = await client
        .get(`/api/v1/projects/user-stories/${story.data.id}/agent-activities/tool-large-read`)
        .loginAs(user)

      detailResponse.assertStatus(200)
      assert.equal((detailResponse.body() as AgentActivityDetailBody).detail, detail)
    } finally {
      await rm(worktree, { force: true, recursive: true })
    }
  })
})

async function createStory(
  client: ApiClient,
  user: Awaited<ReturnType<typeof createUser>>,
  projectId: string
) {
  const response = await client.post('/api/v1/projects/user-stories').loginAs(user).json({
    projectId,
    title: 'Reviewable story',
    summary: 'Initial summary',
  })

  response.assertStatus(200)
  return response.body() as unknown as UserStoryBody
}

function finalizeRun(
  client: ApiClient,
  user: Awaited<ReturnType<typeof createUser>>,
  storyId: string,
  runId: string,
  input: { finalResponse: string; status: 'completed' | 'failed' }
) {
  return client
    .post(`/api/v1/projects/user-stories/${storyId}/agent-runs/${runId}/finalize`)
    .loginAs(user)
    .json({
      activities: [],
      agentLastError: input.status === 'failed' ? input.finalResponse : null,
      agentLastEvent: input.finalResponse,
      finalResponse: input.finalResponse,
      outcome: 'review',
      persistenceEvent: {
        createdAt: new Date().toISOString(),
        eventId: crypto.randomUUID(),
        eventType: input.status,
        executionId: runId,
        runId,
        sequenceNumber: 1,
        sessionId: runId,
      },
      status: input.status,
    })
}

function createProject(userId: string, name: string) {
  return Project.create({
    name,
    repositoryFingerprint: crypto.randomUUID(),
    userId,
  })
}
