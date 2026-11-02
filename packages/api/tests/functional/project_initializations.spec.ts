import Project from '#models/project'
import ProjectCodePractice from '#models/project_code_practice'
import User from '#models/user'
import UserSubscription from '#models/user_subscription'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

type InitializationBody = {
  data: {
    initialization: {
      status: string
      clineSessionId: string | null
      previewManifest: Record<string, unknown> | null
      runConfigurations: Array<{
        id: string
        name: string
        command: string
        cwd: string
        default: boolean
        category: string
        services: string[]
        previewService?: string | null
        scopes: string[]
      }>
      databaseMode: 'existing' | 'compose' | null
      error: string | null
      repairReason: string | null
    } | null
    practices: Array<{
      practice: string
      detected: boolean
      enabled: boolean
      comment: string
    }>
  }
}

test.group('project initializations', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('tracks initialization independently from practices', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    await createCodePractice(project.id)

    const startResponse = await client
      .post(`/api/v1/projects/${project.id}/initialization/start`)
      .loginAs(user)
      .json({
        providerId: 'anthropic',
        modelId: 'claude',
      })

    startResponse.assertStatus(200)
    const started = startResponse.body() as InitializationBody
    assert.equal(started.data.initialization?.status, 'running')

    const completeResponse = await client
      .post(`/api/v1/projects/${project.id}/initialization/complete`)
      .loginAs(user)
      .json({
        clineSessionId: 'session-1',
        previewManifest: previewManifest('high'),
        setupScript: 'echo setup',
        dockerCompose: 'services: {}',
        databaseMode: 'compose',
        runConfigurations: [
          {
            id: 'web',
            name: 'Web application',
            command: 'pnpm dev',
            cwd: '.',
            default: true,
            category: 'web',
            services: ['web'],
            previewService: 'web',
            scopes: ['frontend', 'backend'],
          },
        ],
      } as never)

    completeResponse.assertStatus(200)
    const completed = completeResponse.body() as InitializationBody
    assert.equal(completed.data.initialization?.status, 'done')
    assert.equal(completed.data.initialization?.clineSessionId, 'session-1')
    assert.notProperty(completed.data.initialization?.previewManifest ?? {}, 'version')
    assert.equal(completed.data.initialization?.runConfigurations[0]?.command, 'pnpm dev')
    assert.equal(completed.data.initialization?.runConfigurations[0]?.category, 'web')
    assert.equal(completed.data.initialization?.databaseMode, 'compose')
    assert.deepEqual(completed.data.initialization?.runConfigurations[0]?.services, ['web'])
    assert.notProperty(completed.data.initialization ?? {}, 'setupScript')
    assert.notProperty(completed.data.initialization ?? {}, 'dockerCompose')
    assert.lengthOf(completed.data.practices, 1)
    assert.equal(completed.data.practices[0].comment, 'Strict linting and typing are configured.')
  })

  test('stores initialization failures', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')

    const response = await client
      .post(`/api/v1/projects/${project.id}/initialization/fail`)
      .loginAs(user)
      .json({
        error: 'Agent failed',
      })

    response.assertStatus(200)
    const body = response.body() as InitializationBody
    assert.equal(body.data.initialization?.status, 'error')
    assert.equal(body.data.initialization?.error, 'Agent failed')
  })

  test('repairs initialization artifacts without changing practices', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    await createCodePractice(project.id)
    await client
      .post(`/api/v1/projects/${project.id}/initialization/complete`)
      .loginAs(user)
      .json({
        previewManifest: previewManifest('medium'),
        runConfigurations: [],
      })

    const response = await client
      .post(`/api/v1/projects/${project.id}/initialization/repair`)
      .loginAs(user)
      .json({
        clineSessionId: 'repair-session',
        previewManifest: previewManifest('high'),
        runConfigurations: [
          {
            id: 'web',
            name: 'Web application',
            command: 'corepack pnpm dev',
            cwd: 'apps/web',
            default: true,
            category: 'web',
            services: ['web'],
            previewService: 'web',
            scopes: ['frontend'],
          },
        ],
        reason: 'The previous command forwarded invalid arguments.',
        databaseMode: 'existing',
      })

    response.assertStatus(200)
    const body = response.body() as InitializationBody
    assert.equal(body.data.initialization?.status, 'done')
    assert.equal(body.data.initialization?.clineSessionId, 'repair-session')
    assert.equal(
      body.data.initialization?.repairReason,
      'The previous command forwarded invalid arguments.'
    )
    assert.equal(body.data.initialization?.previewManifest?.confidence, 'high')
    assert.equal(body.data.initialization?.databaseMode, 'existing')
    assert.notProperty(body.data.initialization ?? {}, 'setupScript')
    assert.notProperty(body.data.initialization ?? {}, 'dockerCompose')
    assert.equal(body.data.initialization?.runConfigurations[0]?.command, 'corepack pnpm dev')
    assert.lengthOf(body.data.practices, 1)
    assert.equal(body.data.practices[0].comment, 'Strict linting and typing are configured.')
  })

  test('rejects initialization repair for another user project', async ({ client }) => {
    const owner = await createUser()
    const user = await createUser()
    const project = await createProject(owner.id, 'Alpha')

    const response = await client
      .post(`/api/v1/projects/${project.id}/initialization/repair`)
      .loginAs(user)
      .json({
        previewManifest: previewManifest('high'),
        runConfigurations: [],
        reason: 'Repair',
      })

    response.assertStatus(404)
  })

  test('rejects an invalid preview manifest before persistence', async ({ client }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')

    const response = await client
      .post(`/api/v1/projects/${project.id}/initialization/complete`)
      .loginAs(user)
      .json({
        previewManifest: { version: 2, confidence: 'high' },
        runConfigurations: [],
      })

    response.assertStatus(422)
  })

  test('rejects run configurations outside the preview topology', async ({ client }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const response = await client
      .post(`/api/v1/projects/${project.id}/initialization/complete`)
      .loginAs(user)
      .json({
        previewManifest: previewManifest('high'),
        runConfigurations: [
          {
            id: 'admin',
            name: 'Admin application',
            command: 'pnpm dev',
            cwd: 'apps/admin',
            default: true,
            category: 'web',
            services: ['admin'],
            previewService: 'admin',
            scopes: ['admin'],
          },
        ],
      })

    response.assertStatus(422)
  })

  test('accepts host-only desktop run configurations without container services', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const response = await client
      .post(`/api/v1/projects/${project.id}/initialization/complete`)
      .loginAs(user)
      .json({
        previewManifest: previewManifest('high'),
        runConfigurations: [
          {
            id: 'desktop-dev',
            name: 'Desktop development',
            command: 'pnpm dev',
            cwd: '.',
            default: true,
            category: 'desktop',
            services: [],
            scopes: ['desktop', 'backend'],
          },
          {
            id: 'web',
            name: 'Web application',
            command: 'pnpm dev:web',
            cwd: '.',
            default: false,
            category: 'web',
            services: ['web'],
            previewService: 'web',
            scopes: ['frontend'],
          },
        ],
      })

    response.assertStatus(200)
    const body = response.body() as InitializationBody
    assert.deepEqual(body.data.initialization?.runConfigurations[0]?.services, [])
    assert.equal(body.data.initialization?.runConfigurations[0]?.category, 'desktop')
  })

  test('still rejects container run configurations without services', async ({ client }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')
    const response = await client
      .post(`/api/v1/projects/${project.id}/initialization/complete`)
      .loginAs(user)
      .json({
        previewManifest: previewManifest('high'),
        runConfigurations: [
          {
            id: 'web',
            name: 'Web application',
            command: 'pnpm dev',
            cwd: '.',
            default: true,
            category: 'web',
            services: [],
            previewService: 'web',
            scopes: ['frontend'],
          },
        ],
      })

    response.assertStatus(422)
  })

  test('explicitly rejects the removed Vercel process profile', async ({ client }) => {
    const user = await createUser()
    const response = await client
      .post('/api/v1/preview-sessions')
      .loginAs(user)
      .json({ profile: 'vercel-process' })

    response.assertStatus(400)
    response.assertBodyContains({
      failure: { code: 'INVALID_MANIFEST', retryable: false },
    })
  })
})

function previewManifest(confidence: 'low' | 'medium' | 'high') {
  return {
    confidence,
    project: { root: '.' },
    setup: [],
    services: [
      {
        id: 'web',
        kind: 'preview',
        container: { image: 'node:22-bookworm' },
        command: 'pnpm dev',
        endpoints: [
          {
            id: 'http',
            protocol: 'http',
            port: 3000,
            healthcheck: { type: 'http', path: '/', timeoutMs: 30_000 },
          },
        ],
      },
    ],
    caches: [],
    risks: [],
    probes: [],
  }
}

async function createUser() {
  const user = await User.create({
    email: `${crypto.randomUUID()}@example.com`,
    password: 'password123',
  })
  await createSubscription(user.id)
  return user
}

function createSubscription(userId: string) {
  return UserSubscription.create({
    userId,
    stripeCustomerId: `cus_${userId}`,
    stripeSubscriptionId: `sub_${userId}`,
    stripePriceId: 'price_test',
    stripeCheckoutSessionId: `cs_${userId}`,
    status: 'active',
    currentPeriodEnd: DateTime.utc().plus({ days: 30 }),
    cancelAtPeriodEnd: false,
  })
}

function createProject(userId: string, name: string) {
  return Project.create({
    name,
    repositoryFingerprint: crypto.randomUUID(),
    userId,
  })
}

function createCodePractice(projectId: string) {
  return ProjectCodePractice.create({
    projectId,
    practice: 'coding_style',
    detected: true,
    enabled: true,
    comment: 'Strict linting and typing are configured.',
  })
}
