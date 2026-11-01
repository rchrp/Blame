import Project from '#models/project'
import ProjectCodePractice from '#models/project_code_practice'
import User from '#models/user'
import UserSubscription from '#models/user_subscription'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

type PracticeBody = {
  data: {
    practice: string
    detected: boolean
    enabled: boolean
    comment: string
  }
}

type PracticeListBody = Array<{ transformerData: PracticeBody['data'][] }>

type AnalysisBody = {
  data: {
    status: string
    viewedAt: string | null
  }
}

test.group('project code practices', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('lists practices for a project', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')

    await createPractice(project.id, 'unit_tests', false, false, 'No test runner found.')
    await createPractice(project.id, 'coding_style', true, true, 'ESLint is configured.')

    const response = await client.get(`/api/v1/projects/${project.id}/code-practices`).loginAs(user)

    response.assertStatus(200)
    const body = practicesFrom(response.body() as unknown as PracticeListBody)
    assert.lengthOf(body, 2)
    assert.equal(body[0].practice, 'coding_style')
    assert.equal(body[1].practice, 'unit_tests')
  })

  test('updates enabled without changing detected or comment', async ({ client, assert }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')

    await createPractice(project.id, 'unit_tests', false, false, 'No test runner found.')

    const response = await client
      .patch(`/api/v1/projects/${project.id}/code-practices/unit_tests`)
      .loginAs(user)
      .json({ enabled: true })

    response.assertStatus(200)
    const body = response.body() as PracticeBody
    assert.equal(body.data.practice, 'unit_tests')
    assert.isFalse(body.data.detected)
    assert.isTrue(body.data.enabled)
    assert.equal(body.data.comment, 'No test runner found.')
  })

  test('rejects practices from another user project', async ({ client }) => {
    const owner = await createUser()
    const otherUser = await createUser()
    const project = await createProject(owner.id, 'Alpha')

    await createPractice(project.id, 'coding_style', true, true, 'ESLint is configured.')

    const listResponse = await client
      .get(`/api/v1/projects/${project.id}/code-practices`)
      .loginAs(otherUser)

    listResponse.assertStatus(404)

    const updateResponse = await client
      .patch(`/api/v1/projects/${project.id}/code-practices/coding_style`)
      .loginAs(otherUser)
      .json({ enabled: false })

    updateResponse.assertStatus(404)
  })

  test('analyzes practices independently from project initialization', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')

    const startedResponse = await client
      .post(`/api/v1/projects/${project.id}/code-practice-analysis/start`)
      .loginAs(user)
      .json({ providerId: 'anthropic', modelId: 'claude' })

    startedResponse.assertStatus(200)
    assert.equal((startedResponse.body() as AnalysisBody).data.status, 'running')

    const pendingPracticesResponse = await client
      .get(`/api/v1/projects/${project.id}/code-practices`)
      .loginAs(user)
    const pendingPractices = practicesFrom(
      pendingPracticesResponse.body() as unknown as PracticeListBody
    )
    assert.lengthOf(pendingPractices, 0)

    const completedResponse = await client
      .post(`/api/v1/projects/${project.id}/code-practice-analysis/complete`)
      .loginAs(user)
      .json({
        clineSessionId: 'practices-session',
        practices: analyzedPractices(),
      })

    completedResponse.assertStatus(200)
    const completed = (completedResponse.body() as AnalysisBody).data
    assert.equal(completed.status, 'done')
    assert.isNull(completed.viewedAt)

    const practicesResponse = await client
      .get(`/api/v1/projects/${project.id}/code-practices`)
      .loginAs(user)
    const practices = practicesFrom(practicesResponse.body() as unknown as PracticeListBody)
    assert.lengthOf(practices, 4)
    assert.isTrue(Boolean(practices.find(({ practice }) => practice === 'coding_style')?.enabled))
    assert.isTrue(Boolean(practices.find(({ practice }) => practice === 'unit_tests')?.enabled))
    assert.isFalse(
      Boolean(practices.find(({ practice }) => practice === 'layered_architecture')?.enabled)
    )
    assert.isTrue(
      Boolean(practices.find(({ practice }) => practice === 'commit_message_convention')?.enabled)
    )

    const viewedResponse = await client
      .post(`/api/v1/projects/${project.id}/code-practice-analysis/viewed`)
      .loginAs(user)
    viewedResponse.assertStatus(200)
    assert.isNotNull((viewedResponse.body() as AnalysisBody).data.viewedAt)
  })

  test('rejects incomplete code practice analysis results', async ({ client }) => {
    const user = await createUser()
    const project = await createProject(user.id, 'Alpha')

    const response = await client
      .post(`/api/v1/projects/${project.id}/code-practice-analysis/complete`)
      .loginAs(user)
      .json({ practices: analyzedPractices().slice(0, 3) })

    response.assertStatus(422)
  })
})

function analyzedPractices(): Array<{
  practice: 'coding_style' | 'unit_tests' | 'layered_architecture' | 'commit_message_convention'
  detected: boolean
  comment: string
}> {
  return [
    { practice: 'coding_style', detected: false, comment: 'No strict lint configuration.' },
    { practice: 'unit_tests', detected: true, comment: 'A test suite is configured.' },
    {
      practice: 'layered_architecture',
      detected: false,
      comment: 'No enforced dependency boundaries.',
    },
    {
      practice: 'commit_message_convention',
      detected: true,
      comment: 'Recent commits use Conventional Commits.',
    },
  ]
}

function practicesFrom(items: PracticeListBody) {
  return items.map(({ transformerData }) => transformerData[0])
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

function createPractice(
  projectId: string,
  practice: 'coding_style' | 'unit_tests',
  detected: boolean,
  enabled: boolean,
  comment: string
) {
  return ProjectCodePractice.create({
    projectId,
    practice,
    detected,
    enabled,
    comment,
  })
}
