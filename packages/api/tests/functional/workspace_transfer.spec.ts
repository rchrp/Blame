import Epic from '#models/epic'
import Project from '#models/project'
import User from '#models/user'
import UserStory from '#models/user_story'
import ProviderCredentialsService from '#services/provider_credentials_service'
import UserMcpConfigurationsService from '#services/user_mcp_configurations_service'
import UserStoriesService from '#services/user_stories_service'
import WorkspaceTransferService, {
  derivedId,
  type WorkspaceBundle,
} from '#services/workspace_transfer_service'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { deployment } from '#lib/deployment'

// Accounts receive workspaces on the hosted API only.
const accountApi = deployment.hostedServices ? false : 'Runs against the hosted API only'

function createUser() {
  return User.create({ email: `${randomUUID()}@example.com`, password: 'password123' })
}

async function localWorkspace() {
  const user = await createUser()
  const project = await Project.create({
    name: 'Shop',
    userId: user.id,
    repositoryFingerprint: 'fingerprint-shop',
  })
  const stories = new UserStoriesService()
  await stories.create(user.id, { projectId: project.id, title: 'Checkout', summary: 'Pay' })
  await stories.create(user.id, { projectId: project.id, title: 'Cart', summary: 'Keep items' })
  await new ProviderCredentialsService().save(user.id, {
    providerId: 'anthropic',
    label: 'Default',
    apiKey: 'sk-local-secret',
  })
  return { user, project }
}

/**
 * Exports a workspace, then removes it here: the local API and the account
 * live in different databases, so imported rows must not find the originals.
 */
async function handOver(userId: string) {
  const bundle = await new WorkspaceTransferService().export(userId)
  await db.from('projects').where('user_id', userId).delete()
  await db.from('provider_credentials').where('user_id', userId).delete()
  return bundle
}

function count(table: string, column: string, value: string) {
  return db
    .from(table)
    .where(column, value)
    .count('* as total')
    .first()
    .then((row) => Number(row?.total))
}

test.group('workspace transfer', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('moves a workspace into an account and imports it only once', async ({ assert }) => {
    const local = await localWorkspace()
    const account = await createUser()
    const transfer = new WorkspaceTransferService()
    const bundle = await handOver(local.user.id)

    const first = await transfer.import(account.id, bundle)
    const second = await transfer.import(account.id, bundle)

    assert.deepEqual(first, { projects: 1, provider_credentials: 1, user_stories: 2 })
    assert.deepEqual(second, { projects: 0, provider_credentials: 0, user_stories: 0 })
    const projects = await Project.query().where('userId', account.id)
    assert.lengthOf(projects, 1)
    assert.equal(projects[0].lastStoryNumber, 2)
    const credential = await new ProviderCredentialsService().resolve(account.id, {
      providerId: 'anthropic',
      label: 'Default',
    })
    assert.equal(credential?.apiKey, 'sk-local-secret')
  })

  test('moves epics and the new fields of stories', async ({ assert }) => {
    const local = await createUser()
    const project = await Project.create({
      name: 'Shop',
      userId: local.id,
      repositoryFingerprint: 'fingerprint-shop',
    })
    const epic = await Epic.create({
      projectId: project.id,
      title: 'Checkout',
      goal: 'Pay',
      branch: 'epic/checkout',
      engineSessionId: 'orchestrator-session',
      settings: { modelRange: { min: 0.1, max: 0.9 }, askBeforeLaunch: true },
    })
    const stories = new UserStoriesService()
    const first = await stories.create(local.id, {
      projectId: project.id,
      title: 'Cart',
      summary: 'Keep items',
      epicId: epic.id,
    })
    const second = await stories.create(local.id, {
      projectId: project.id,
      title: 'Pay',
      summary: 'Charge',
      epicId: epic.id,
      modelIntent: 'smarter',
      requestedModel: { providerId: 'openai', modelId: 'gpt', reasoningEffort: 'high' },
      startsAfter: [first.id],
    })
    const account = await createUser()
    const transfer = new WorkspaceTransferService()
    const bundle = await handOver(local.id)
    // MySQL hands JSON columns back as objects, SQLite as text: take both.
    const row = bundle.tables.epics?.[0]
    if (typeof row!.settings === 'string') row!.settings = JSON.parse(row!.settings)

    const imported = await transfer.import(account.id, bundle)
    const again = await transfer.import(account.id, bundle)

    assert.equal(imported.epics, 1)
    assert.equal(again.epics, 0)
    const moved = await Epic.findOrFail(epic.id)
    assert.equal(moved.title, 'Checkout')
    assert.equal(moved.engineSessionId, 'orchestrator-session')
    assert.deepEqual(moved.settings, { modelRange: { min: 0.1, max: 0.9 }, askBeforeLaunch: true })
    const story = await UserStory.findOrFail(second.id)
    assert.equal(story.epicId, epic.id)
    assert.equal(story.modelIntent, 'smarter')
    assert.deepEqual(story.requestedModel, {
      providerId: 'openai',
      modelId: 'gpt',
      reasoningEffort: 'high',
    })
    assert.deepEqual(story.startsAfter, [first.id])
  })

  test('merges into the project the account has for the same repository', async ({ assert }) => {
    const local = await localWorkspace()
    const account = await createUser()
    const existing = await Project.create({
      name: 'Shop',
      userId: account.id,
      repositoryFingerprint: 'fingerprint-shop',
    })
    await new UserStoriesService().create(account.id, {
      projectId: existing.id,
      title: 'Made in the account',
      summary: 'Already there',
    })

    await new WorkspaceTransferService().import(account.id, await handOver(local.user.id))

    assert.equal(await count('projects', 'user_id', account.id), 1)
    const numbers = await db
      .from('user_stories')
      .where('project_id', existing.id)
      .orderBy('story_number')
      .select('story_number', 'title')
    assert.deepEqual(
      numbers.map((story) => [story.story_number, story.title]),
      [
        [1, 'Made in the account'],
        [2, 'Checkout'],
        [3, 'Cart'],
      ]
    )
    await existing.refresh()
    assert.equal(existing.lastStoryNumber, 3)
  })

  test('keeps the settings an account already has', async ({ assert }) => {
    const local = await localWorkspace()
    const account = await createUser()
    await new ProviderCredentialsService().save(account.id, {
      providerId: 'anthropic',
      label: 'Default',
      apiKey: 'sk-account-secret',
    })

    await new WorkspaceTransferService().import(account.id, await handOver(local.user.id))

    const credential = await new ProviderCredentialsService().resolve(account.id, {
      providerId: 'anthropic',
      label: 'Default',
    })
    assert.equal(credential?.apiKey, 'sk-account-secret')
  })

  test('never attaches rows to another user', async ({ assert }) => {
    const local = await localWorkspace()
    const stranger = await localWorkspace()
    const account = await createUser()
    const transfer = new WorkspaceTransferService()
    const bundle = await handOver(local.user.id)
    const strangerStories = await transfer.export(stranger.user.id)
    bundle.tables.user_stories = strangerStories.tables.user_stories

    await transfer.import(account.id, bundle)

    assert.equal(await count('user_stories', 'project_id', stranger.project.id), 2)
    assert.equal(await count('projects', 'user_id', account.id), 1)
    const accountProject = await Project.findByOrFail('userId', account.id)
    assert.equal(await count('user_stories', 'project_id', accountProject.id), 0)
  })

  test('moves the same workspace into a second account', async ({ assert }) => {
    const local = await createUser()
    const project = await Project.create({
      name: 'Shop',
      userId: local.id,
      repositoryFingerprint: 'fingerprint-shop',
    })
    const epic = await Epic.create({
      projectId: project.id,
      title: 'Checkout',
      goal: 'Pay',
      branch: 'epic/checkout',
      engineSessionId: 'orchestrator-session',
      settings: { modelRange: { min: 0.1, max: 0.9 }, askBeforeLaunch: true },
    })
    const stories = new UserStoriesService()
    const cart = await stories.create(local.id, {
      projectId: project.id,
      title: 'Cart',
      summary: 'Keep items',
      epicId: epic.id,
    })
    const pay = await stories.create(local.id, {
      projectId: project.id,
      title: 'Pay',
      summary: 'Charge',
      startsAfter: [cart.id],
    })
    await new ProviderCredentialsService().save(local.id, {
      providerId: 'anthropic',
      label: 'Default',
      apiKey: 'sk-local-secret',
    })
    const bundle = await handOver(local.id)
    const first = await createUser()
    const second = await createUser()
    const transfer = new WorkspaceTransferService()

    await transfer.import(first.id, bundle)
    const imported = await transfer.import(second.id, bundle)
    const again = await transfer.import(second.id, bundle)

    assert.deepEqual(imported, {
      projects: 1,
      provider_credentials: 1,
      epics: 1,
      user_stories: 2,
    })
    assert.deepEqual(again, {
      projects: 0,
      provider_credentials: 0,
      epics: 0,
      user_stories: 0,
    })
    // The first account keeps the original rows.
    const original = await Project.findOrFail(project.id)
    const originalEpic = await Epic.findOrFail(epic.id)
    assert.equal(original.userId, first.id)
    assert.equal(originalEpic.engineSessionId, 'orchestrator-session')
    const copy = await Project.findByOrFail('userId', second.id)
    assert.equal(copy.id, derivedId(second.id, 'projects', project.id))
    assert.equal(copy.lastStoryNumber, 2)
    const copiedEpic = await Epic.findByOrFail('projectId', copy.id)
    assert.notEqual(copiedEpic.id, epic.id)
    assert.isNull(copiedEpic.engineSessionId)
    const copiedCart = await UserStory.findOrFail(derivedId(second.id, 'user_stories', cart.id))
    const copiedPay = await UserStory.findOrFail(derivedId(second.id, 'user_stories', pay.id))
    assert.equal(copiedCart.projectId, copy.id)
    assert.equal(copiedCart.epicId, copiedEpic.id)
    assert.deepEqual(copiedPay.startsAfter, [copiedCart.id])
    const credential = await new ProviderCredentialsService().resolve(second.id, {
      providerId: 'anthropic',
      label: 'Default',
    })
    assert.equal(credential?.apiKey, 'sk-local-secret')
  })

  test('lands every part of a workspace sent in pieces on the same rows', async ({ assert }) => {
    const local = await localWorkspace()
    const [checkout, cart] = await db
      .from('user_stories')
      .where('project_id', local.project.id)
      .orderBy('story_number')
    await db
      .from('user_stories')
      .where('id', cart.id)
      .update({ starts_after: JSON.stringify([checkout.id]) })
    const bundle = await handOver(local.user.id)
    const owner = await createUser()
    const account = await createUser()
    const transfer = new WorkspaceTransferService()
    await transfer.import(owner.id, bundle)
    const [firstStory, secondStory] = bundle.tables.user_stories!
    const piece = (rows: typeof bundle.tables.user_stories) => ({
      ...bundle,
      tables: { projects: bundle.tables.projects, user_stories: rows },
    })

    await transfer.import(account.id, piece([firstStory]))
    await transfer.import(account.id, piece([secondStory]))

    const projects = await Project.query().where('userId', account.id)
    assert.lengthOf(projects, 1)
    const moved = await db
      .from('user_stories')
      .where('project_id', projects[0].id)
      .orderBy('story_number')
    assert.deepEqual(
      moved.map((story) => [story.story_number, story.title]),
      [
        [1, 'Checkout'],
        [2, 'Cart'],
      ]
    )
    const startsAfter = moved[1].starts_after
    assert.deepEqual(typeof startsAfter === 'string' ? JSON.parse(startsAfter) : startsAfter, [
      moved[0].id,
    ])
  })

  test('merges a workspace made without signing in on a second computer', async ({ assert }) => {
    // The account, used on the first computer.
    const account = await createUser()
    const existing = await Project.create({
      name: 'Shop',
      userId: account.id,
      repositoryFingerprint: 'fingerprint-shop',
    })
    const stories = new UserStoriesService()
    await stories.create(account.id, { projectId: existing.id, title: 'Login', summary: 'In' })
    const removed = await stories.create(account.id, {
      projectId: existing.id,
      title: 'Removed',
      summary: 'Gone',
    })
    await db.from('user_stories').where('id', removed.id).delete()
    await new ProviderCredentialsService().save(account.id, {
      providerId: 'anthropic',
      label: 'Default',
      apiKey: 'sk-account-secret',
    })
    const mcp = new UserMcpConfigurationsService()
    await mcp.save(account.id, {
      servers: [
        {
          name: 'GitHub',
          transport: 'streamableHttp',
          url: 'https://github.example.com/mcp',
          disabled: false,
          secrets: { headers: { Authorization: 'account-token' } },
        },
      ],
    })
    // The same repository, providers and servers, set up again without an account.
    const local = await localWorkspace()
    await mcp.save(local.user.id, {
      servers: [
        {
          name: 'github',
          transport: 'streamableHttp',
          url: 'https://github.example.com/mcp',
          disabled: false,
          secrets: { headers: { Authorization: 'local-token' } },
        },
        {
          name: 'Linear',
          transport: 'streamableHttp',
          url: 'https://linear.example.com/mcp',
          disabled: false,
          secrets: { headers: { Authorization: 'linear-token' } },
        },
      ],
    })
    const bundle = await handOver(local.user.id)
    await db.from('user_mcp_configurations').where('user_id', local.user.id).delete()
    const transfer = new WorkspaceTransferService()

    const imported = await transfer.import(account.id, bundle)
    const again = await transfer.import(account.id, bundle)

    assert.deepEqual(imported, {
      projects: 0,
      provider_credentials: 0,
      user_mcp_configurations: 1,
      user_stories: 2,
    })
    assert.deepEqual(again, {
      projects: 0,
      provider_credentials: 0,
      user_mcp_configurations: 0,
      user_stories: 0,
    })
    assert.equal(await count('projects', 'user_id', account.id), 1)
    const numbers = await db
      .from('user_stories')
      .where('project_id', existing.id)
      .orderBy('story_number')
      .select('story_number', 'title')
    // Number 2 went to a deleted story: the imported ones come after it.
    assert.deepEqual(
      numbers.map((story) => [story.story_number, story.title]),
      [
        [1, 'Login'],
        [3, 'Checkout'],
        [4, 'Cart'],
      ]
    )
    await existing.refresh()
    assert.equal(existing.lastStoryNumber, 4)
    const credential = await new ProviderCredentialsService().resolve(account.id, {
      providerId: 'anthropic',
      label: 'Default',
    })
    assert.equal(credential?.apiKey, 'sk-account-secret')
    const configuration = await mcp.get(account.id)
    const servers = await mcp.present(configuration!)
    assert.deepEqual(
      servers.map((server) => [server.name, server.secrets?.headers?.Authorization]),
      [
        ['GitHub', 'account-token'],
        ['Linear', 'linear-token'],
      ]
    )
  })

  test('imports through the account API, idempotently', async ({ client, assert }) => {
    const local = await localWorkspace()
    const account = await createUser()
    const bundle = JSON.parse(JSON.stringify(await handOver(local.user.id)))

    const first = await client.put('/api/v1/account/workspace').loginAs(account).json(bundle)
    const again = await client.put('/api/v1/account/workspace').loginAs(account).json(bundle)

    first.assertStatus(200)
    first.assertBodyContains({ data: { projects: 1, user_stories: 2 } })
    again.assertBodyContains({ data: { projects: 0, user_stories: 0 } })
    assert.equal(await count('projects', 'user_id', account.id), 1)
  }).skip(Boolean(accountApi), accountApi || undefined)

  test('refuses something that is not a workspace', async ({ client }) => {
    const account = await createUser()
    const response = await client
      .put('/api/v1/account/workspace')
      .loginAs(account)
      // Not a workspace on purpose: the server, not the types, refuses it.
      .json({ format: 'other', version: 1, tables: {} } as unknown as WorkspaceBundle)
    response.assertStatus(422)
  }).skip(Boolean(accountApi), accountApi || undefined)
})
