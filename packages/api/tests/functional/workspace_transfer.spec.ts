import Project from '#models/project'
import User from '#models/user'
import ProviderCredentialsService from '#services/provider_credentials_service'
import UserStoriesService from '#services/user_stories_service'
import WorkspaceTransferService from '#services/workspace_transfer_service'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'

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

/** Exports then clears, as the local API does: the account lives in another database. */
async function handOver(userId: string) {
  const transfer = new WorkspaceTransferService()
  const bundle = await transfer.export(userId)
  await transfer.clear(userId)
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

  test('clears the local workspace after the handover', async ({ assert }) => {
    const local = await localWorkspace()
    await new WorkspaceTransferService().clear(local.user.id)

    assert.equal(await count('projects', 'user_id', local.user.id), 0)
    assert.equal(await count('provider_credentials', 'user_id', local.user.id), 0)
    assert.equal(await count('user_stories', 'project_id', local.project.id), 0)
  })
})
