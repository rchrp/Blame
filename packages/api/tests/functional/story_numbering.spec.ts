import Project from '#models/project'
import UserStory from '#models/user_story'
import UserStoriesService from '#services/user_stories_service'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import StoryCounterMigration from '../../database/migrations/1784100000000_add_project_story_counter.js'
import { createLicensedUser } from '../helpers/create_licensed_user.js'

async function fixture() {
  const user = await createLicensedUser()
  const project = await Project.create({ name: 'Numbering', userId: user.id })
  return { user, project }
}

async function create(client: ApiClient, { user, project }: Awaited<ReturnType<typeof fixture>>) {
  const response = await client.post('/api/v1/projects/user-stories').loginAs(user).json({
    projectId: project.id,
    title: 'Same title',
    summary: 'Same content, different story',
  })
  response.assertStatus(200)
  return response.body().data as { id: string; storyNumber: number }
}

test.group('persistent story numbering', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('does not reuse the last number after deleting every story', async ({ client, assert }) => {
    const context = await fixture()
    for (const number of [1, 2, 3]) {
      const story = await create(client, context)
      assert.equal(story.storyNumber, number)
      const removed = await client
        .delete(`/api/v1/projects/user-stories/${story.id}`)
        .loginAs(context.user)
      removed.assertStatus(204)
      assert.isNull(await UserStory.find(story.id))
    }
    assert.equal((await create(client, context)).storyNumber, 4)
  })

  test('serializes concurrent creations in an empty project', async ({ client, assert }) => {
    const context = await fixture()
    const stories = await Promise.all(Array.from({ length: 8 }, () => create(client, context)))
    assert.deepEqual(
      stories.map((story) => story.storyNumber).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8]
    )
    assert.equal((await context.project.refresh()).lastStoryNumber, 8)
  })

  test('numbers projects independently and reserves a new number when moving a story', async ({
    client,
    assert,
  }) => {
    const alpha = await fixture()
    const beta = {
      user: alpha.user,
      project: await Project.create({ userId: alpha.user.id, name: 'Beta' }),
    }
    const first = await create(client, alpha)
    assert.equal((await create(client, beta)).storyNumber, 1)
    const moved = await client
      .patch(`/api/v1/projects/user-stories/${first.id}`)
      .loginAs(alpha.user)
      .json({ projectId: beta.project.id })
    moved.assertStatus(200)
    assert.equal((moved.body() as { data: { storyNumber: number } }).data.storyNumber, 2)
    assert.equal((await create(client, alpha)).storyNumber, 2)
    assert.equal((await create(client, beta)).storyNumber, 3)
  })

  test('migration starts counters above existing story numbers', async ({ client, assert }) => {
    const context = await fixture()
    const empty = {
      user: context.user,
      project: await Project.create({ userId: context.user.id, name: 'Empty' }),
    }
    const story = await create(client, context)
    await UserStory.query().where('id', story.id).update({ storyNumber: 41 })
    await new StoryCounterMigration(db.connection(), 'story-counter').execDown()
    await new StoryCounterMigration(db.connection(), 'story-counter').execUp()
    assert.equal((await context.project.refresh()).lastStoryNumber, 41)
    assert.equal((await empty.project.refresh()).lastStoryNumber, 0)
    assert.equal((await create(client, context)).storyNumber, 42)
    assert.equal((await create(client, empty)).storyNumber, 1)
  })

  test('rejects another user before reserving a number', async ({ client, assert }) => {
    const context = await fixture()
    const otherUser = await createLicensedUser()
    const response = await client.post('/api/v1/projects/user-stories').loginAs(otherUser).json({
      projectId: context.project.id,
      title: 'Forbidden',
      summary: 'Forbidden',
    })
    response.assertStatus(404)
    assert.equal((await context.project.refresh()).lastStoryNumber, 0)
    assert.equal((await create(client, context)).storyNumber, 1)
  })

  test('rolls back the reservation if inserting the story fails', async ({ client, assert }) => {
    const context = await fixture()
    // Bypass HTTP validation to provoke an actual SQL failure after the
    // project counter has been incremented in the creation transaction.
    await assert.rejects(() =>
      new UserStoriesService().create(context.user.id, {
        projectId: context.project.id,
        title: 'x'.repeat(256),
        summary: 'Too long for the title column',
      })
    )
    assert.equal((await context.project.refresh()).lastStoryNumber, 0)
    assert.equal((await create(client, context)).storyNumber, 1)
  })
})
