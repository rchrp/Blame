import Project from '#models/project'
import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'

type QuickChatBody = {
  data: {
    agentFinalResponse?: string | null
    agentRuns?: QuickChatAgentRunBody['data'][]
    id: string
    messages?: QuickChatMessageBody['data'][]
    title: string
  }
}

type QuickChatListBody = {
  data: QuickChatBody['data'][]
}

type QuickChatMessageBody = {
  data: {
    body: string
    id: string
    quickChatId: string
  }
}

type QuickChatAgentRunBody = {
  data: {
    activities?: {
      detail: string
      id: string
      kind: string
    }[]
    checkpointRunCount?: number | null
    diffEndRef?: string | null
    finalResponse?: string | null
    id: string
    kind: string
    lastSequenceNumber?: number
    quickChatId: string
    status: string
  }
}

test.group('quick chats', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('lists quick chat summaries without detail payloads', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const createResponse = await client.post('/api/v1/projects/quick-chats').loginAs(user).json({
      projectId: project.id,
      title: 'Large chat',
      workspace: '/workspace',
    })
    const chat = createResponse.body() as unknown as QuickChatBody
    const messageResponse = await client
      .post(`/api/v1/projects/quick-chats/${chat.data.id}/messages`)
      .loginAs(user)
      .json({ body: 'Please change the layout' })
    const message = messageResponse.body() as unknown as QuickChatMessageBody

    await client
      .post(`/api/v1/projects/quick-chats/${chat.data.id}/agent-runs`)
      .loginAs(user)
      .json({ kind: 'resume', messageId: message.data.id })

    const summaryResponse = await client
      .get('/api/v1/projects/quick-chats')
      .qs({ projectId: project.id, view: 'summary' })
      .loginAs(user)

    summaryResponse.assertStatus(200)
    const summary = summaryResponse.body() as unknown as QuickChatListBody
    assert.equal(summary.data[0].title, 'Large chat')
    assert.isUndefined(summary.data[0].agentFinalResponse)
    assert.isUndefined(summary.data[0].messages)
    assert.isUndefined(summary.data[0].agentRuns)

    const detailResponse = await client
      .get(`/api/v1/projects/quick-chats/${chat.data.id}`)
      .loginAs(user)

    detailResponse.assertStatus(200)
    const detail = detailResponse.body() as unknown as QuickChatBody
    assert.lengthOf(detail.data.messages ?? [], 1)
    assert.lengthOf(detail.data.agentRuns ?? [], 1)
  })

  test('persists run boundaries and undoes the exact message run', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const chatResponse = await client.post('/api/v1/projects/quick-chats').loginAs(user).json({
      projectId: project.id,
      title: 'History',
    })
    const chat = chatResponse.body() as unknown as QuickChatBody
    const firstMessageResponse = await client
      .post(`/api/v1/projects/quick-chats/${chat.data.id}/messages`)
      .loginAs(user)
      .json({ body: 'First' })
    const firstMessage = firstMessageResponse.body() as unknown as QuickChatMessageBody
    const firstRunResponse = await client
      .post(`/api/v1/projects/quick-chats/${chat.data.id}/agent-runs`)
      .loginAs(user)
      .json({ checkpointRunCount: 4, kind: 'resume', messageId: firstMessage.data.id })
    const firstRun = firstRunResponse.body() as unknown as QuickChatAgentRunBody
    const ref = 'a'.repeat(40)
    const updatedRunResponse = await client
      .patch(`/api/v1/projects/quick-chats/${chat.data.id}/agent-runs/${firstRun.data.id}`)
      .loginAs(user)
      .json({ diffEndRef: ref, status: 'completed' })
    const updatedRun = updatedRunResponse.body() as unknown as QuickChatAgentRunBody
    assert.equal(updatedRun.data.checkpointRunCount, 4)
    assert.equal(updatedRun.data.diffEndRef, ref)

    const secondMessageResponse = await client
      .post(`/api/v1/projects/quick-chats/${chat.data.id}/messages`)
      .loginAs(user)
      .json({ body: 'Second' })
    const secondMessage = secondMessageResponse.body() as unknown as QuickChatMessageBody
    const secondRunResponse = await client
      .post(`/api/v1/projects/quick-chats/${chat.data.id}/agent-runs`)
      .loginAs(user)
      .json({ checkpointRunCount: 5, kind: 'resume', messageId: secondMessage.data.id })
    const secondRun = secondRunResponse.body() as unknown as QuickChatAgentRunBody

    const invalidUndo = await client
      .post(`/api/v1/projects/quick-chats/${chat.data.id}/messages/${firstMessage.data.id}/undo`)
      .loginAs(user)
      .json({ runId: secondRun.data.id })
    invalidUndo.assertStatus(409)

    const undoResponse = await client
      .post(`/api/v1/projects/quick-chats/${chat.data.id}/messages/${secondMessage.data.id}/undo`)
      .loginAs(user)
      .json({ runId: secondRun.data.id })
    undoResponse.assertStatus(200)
    const undone = undoResponse.body() as unknown as QuickChatBody
    assert.deepEqual(
      (undone.data.messages ?? []).map((message) => message.id),
      [firstMessage.data.id]
    )
    assert.deepEqual(
      (undone.data.agentRuns ?? []).map((run) => run.id),
      [firstRun.data.id]
    )
  })

  test('finalizes response-only runs transactionally and replays idempotently', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const fixture = await responseOnlyRun(client, user, project.id)
    const input = responseOnlyFinalization(fixture)
    const finalized = await finalizeQuickChatRun(client, user, fixture, input)
    assert.equal(finalized.data.agentFinalResponse, input.finalResponse)
    assert.equal(finalized.data.agentRuns?.[0]?.finalResponse, input.finalResponse)
    assert.equal(finalized.data.agentRuns?.[0]?.lastSequenceNumber, 1)
    assert.deepEqual(
      finalized.data.agentRuns?.[0]?.activities?.map((activity) => activity.id),
      ['message-final']
    )

    const replayed = await finalizeQuickChatRun(client, user, fixture, input)
    assert.lengthOf(replayed.data.agentRuns?.[0]?.activities ?? [], 1)
  })
})

async function responseOnlyRun(
  client: ApiClient,
  user: Awaited<ReturnType<typeof createUser>>,
  projectId: string
) {
  const chatResponse = await client.post('/api/v1/projects/quick-chats').loginAs(user).json({
    projectId,
    title: 'Response fallback',
  })
  const chat = chatResponse.body() as unknown as QuickChatBody
  const executionId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const runResponse = await client
    .post(`/api/v1/projects/quick-chats/${chat.data.id}/agent-runs`)
    .loginAs(user)
    .json({ clineSessionId: sessionId, executionId, kind: 'resume' })
  return {
    chat,
    executionId,
    run: runResponse.body() as unknown as QuickChatAgentRunBody,
    sessionId,
  }
}

function responseOnlyFinalization(fixture: Awaited<ReturnType<typeof responseOnlyRun>>) {
  return {
    activities: [],
    agentLastError: null,
    agentLastEvent: 'Agent completed.',
    agentStatus: null,
    finalResponse: 'Delivered only by done.',
    persistenceEvent: {
      createdAt: new Date().toISOString(),
      eventId: crypto.randomUUID(),
      eventType: 'done',
      executionId: fixture.executionId,
      runId: fixture.run.data.id,
      sequenceNumber: 1,
      sessionId: fixture.sessionId,
    },
    status: 'completed' as const,
  }
}

async function finalizeQuickChatRun(
  client: ApiClient,
  user: Awaited<ReturnType<typeof createUser>>,
  fixture: Awaited<ReturnType<typeof responseOnlyRun>>,
  input: ReturnType<typeof responseOnlyFinalization>
) {
  const response = await client
    .post(
      `/api/v1/projects/quick-chats/${fixture.chat.data.id}/agent-runs/${fixture.run.data.id}/finalize`
    )
    .loginAs(user)
    .json(input)
  response.assertStatus(200)
  return response.body() as unknown as QuickChatBody
}

function createUser() {
  return User.create({
    email: `${crypto.randomUUID()}@example.com`,
    password: 'password123',
  })
}

function createProject(userId: string, name: string) {
  return Project.create({
    name,
    repositoryFingerprint: crypto.randomUUID(),
    userId,
  })
}
