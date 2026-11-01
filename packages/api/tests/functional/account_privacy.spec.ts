import AccountClosureRequest from '#models/account_closure_request'
import AccountClosureService from '#services/account_closure_service'
import Project from '#models/project'
import ProjectCodePractice from '#models/project_code_practice'
import ProjectInitialization from '#models/project_initialization'
import ProviderCredential from '#models/provider_credential'
import QuickChat from '#models/quick_chat'
import QuickChatAgentRun from '#models/quick_chat_agent_run'
import QuickChatMessage from '#models/quick_chat_message'
import User from '#models/user'
import UserAiPreference from '#models/user_ai_preference'
import UserMcpConfiguration from '#models/user_mcp_configuration'
import UserSubscription from '#models/user_subscription'
import UserStory from '#models/user_story'
import UserStoryAgentRun from '#models/user_story_agent_run'
import UserStoryComment from '#models/user_story_comment'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const password = 'password123'
const encryptedApiKey = 'encrypted-api-key-must-not-export'
const encryptedOauthCredentials = 'encrypted-oauth-must-not-export'

test.group('account privacy', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('requires the current password for an account export', async ({ client }) => {
    const user = await createUser()
    const response = await client.post('/api/v1/account/export').loginAs(user).json({
      password: 'incorrect-password',
    })

    response.assertStatus(401)
    response.assertBodyContains({ code: 'ACCOUNT_VERIFICATION_FAILED' })
  })

  test('requires authentication for account privacy actions', async ({ client }) => {
    const exportResponse = await client.post('/api/v1/account/export').json({ password })
    const closureResponse = await client.post('/api/v1/account/closure').json({
      password,
      confirmation: 'person@example.com',
    })

    exportResponse.assertStatus(401)
    closureResponse.assertStatus(401)
  })

  test('exports owned cloud data without reusable secrets', async ({ client, assert }) => {
    const user = await createUser()
    const stranger = await createUser()
    await createOwnedData(user)
    await Project.create({ userId: stranger.id, name: 'Private stranger project' })

    const response = await client.post('/api/v1/account/export').loginAs(user).json({ password })
    response.assertStatus(200)
    const body = response.body() as unknown as AccountExportBody
    const serialized = JSON.stringify(body)
    const passwordHash = user.password
    if (!passwordHash) {
      throw new Error('Expected the password user to have a password hash')
    }

    assert.equal(body.format, 'blame-account-export')
    assert.equal(body.account.email, user.email)
    assert.equal(body.security.dedicatedAuthenticationSecretsIncluded, false)
    assert.include(serialized, 'Owned project')
    assert.include(serialized, 'Owned story')
    assert.include(serialized, 'Owned quick chat')
    assert.notInclude(serialized, 'Private stranger project')
    assert.notInclude(serialized, passwordHash)
    assert.notInclude(serialized, encryptedApiKey)
    assert.notInclude(serialized, encryptedOauthCredentials)
    assert.equal(response.headers()['cache-control'], 'private, no-store')
  })

  test('requires exact account confirmation before closure', async ({ client }) => {
    const user = await createUser()
    const response = await client.post('/api/v1/account/closure').loginAs(user).json({
      password,
      confirmation: 'different@example.com',
    })

    response.assertStatus(401)
    await User.findOrFail(user.id)
  })

  test('rate limits repeated account verification failures', async ({ client }) => {
    const user = await createUser()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await client.post('/api/v1/account/export').loginAs(user).json({
        password: 'incorrect-password',
      })
      response.assertStatus(401)
    }

    const blockedResponse = await client.post('/api/v1/account/export').loginAs(user).json({
      password,
    })
    blockedResponse.assertStatus(429)
    blockedResponse.assertHeader('retry-after', '900')
  })

  test('prevents sign-in while a failed deletion is awaiting retry', async ({ client }) => {
    const user = await createUser()
    user.closureRequestedAt = DateTime.utc()
    user.activeDeletionDeadline = DateTime.utc().plus({ days: 30 })
    await user.save()

    const response = await client.post('/api/v1/auth/login').json({
      email: user.email,
      password,
    })

    response.assertStatus(403)
    response.assertBodyContains({ code: 'ACCOUNT_CLOSURE_IN_PROGRESS' })
  })

  test('closes the account and removes every active cloud data chain', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const stranger = await createUser()
    const ownedData = await createOwnedData(user)
    const response = await client.post('/api/v1/account/closure').loginAs(user).json({
      password,
      confirmation: user.email,
    })

    response.assertStatus(200)
    const receipt = response.body() as unknown as ClosureReceipt
    assert.equal(receipt.status, 'completed')
    assert.isNotNull(receipt.receiptToken)
    await assertReceiptStatus(client, receipt)
    await assertClosureDeadlines(receipt, assert)
    await assertUserDataDeleted(user.id, ownedData, assert)
    await User.findOrFail(stranger.id)
    await assertClosureArchive(user, assert)
  })

  test('retains billing evidence and retries failed Stripe cleanup', async ({ assert }) => {
    const user = await createUser()
    const subscription = await createSubscription(user.id)
    const cleanup = new FailingOnceBillingCleanup()
    const service = new AccountClosureService(cleanup)

    const receipt = await service.close(user)
    assert.equal(receipt.status, 'pending_external_cleanup')
    assert.isNull(await User.find(user.id))
    assert.lengthOf(await db.from('user_subscriptions').where('user_id', user.id), 0)

    const closure = await AccountClosureRequest.findByOrFail('source_user_id', user.id)
    assertBillingEvidence(closure, subscription, assert)
    closure.nextRetryAt = DateTime.utc().minus({ minutes: 1 })
    await closure.save()
    await service.retryPending()
    await closure.refresh()
    assert.equal(closure.status, 'completed')
    assert.equal(cleanup.attempts, 2)
  })

  test('blocks and removes an account resurrected by a database restore', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const service = new AccountClosureService()
    await service.close(user)
    await AccountClosureRequest.query().where('source_user_id', user.id).delete()
    await restoreUser(user)

    const loginResponse = await client.post('/api/v1/auth/login').json({
      email: user.email,
      password,
    })
    loginResponse.assertStatus(403)
    const reconciled = await service.reconcileLedger()
    assert.equal(reconciled, 1)
    assert.isNull(await User.find(user.id))
    const closure = await AccountClosureRequest.findByOrFail('source_user_id', user.id)
    assert.equal(closure.status, 'completed')
  })
})

async function createUser() {
  const email = `${crypto.randomUUID()}@example.com`
  return User.create({ email, fullName: 'Privacy Tester', password })
}

async function createOwnedData(user: User) {
  const project = await Project.create({ userId: user.id, name: 'Owned project' })
  await createProjectDetails(project.id)
  const storyId = await createStory(project.id)
  const chatId = await createQuickChat(project.id)
  await createAccountSettings(user)
  await User.accessTokens.create(user)
  return { chatId, projectId: project.id, storyId }
}

async function createStory(projectId: string) {
  const story = await UserStory.create({
    projectId,
    storyNumber: 1,
    title: 'Owned story',
    summary: 'Export and delete this story',
    status: 'backlog',
    priority: 'Medium',
    owner: 'user',
  })
  const comment = await UserStoryComment.create({
    userStoryId: story.id,
    body: 'Owned comment',
    author: 'user',
  })
  await UserStoryAgentRun.create({
    userStoryId: story.id,
    commentId: comment.id,
    kind: 'change-request',
    status: 'completed',
  })
  return story.id
}

async function createQuickChat(projectId: string) {
  const chat = await QuickChat.create({ projectId, title: 'Owned quick chat' })
  const message = await QuickChatMessage.create({
    quickChatId: chat.id,
    body: 'Owned message',
    author: 'user',
  })
  await QuickChatAgentRun.create({
    quickChatId: chat.id,
    messageId: message.id,
    kind: 'initial',
    status: 'completed',
  })
  return chat.id
}

async function createProjectDetails(projectId: string) {
  await ProjectInitialization.create({ projectId, status: 'done', step: 'complete' })
  await ProjectCodePractice.create({
    projectId,
    practice: 'unit_tests',
    detected: true,
    enabled: true,
    comment: 'Tests are present',
  })
}

async function createAccountSettings(user: User) {
  await ProviderCredential.create({
    userId: user.id,
    providerId: 'openai',
    label: 'private',
    encryptedApiKey,
    encryptedOauthCredentials,
    authMethod: 'oauth',
  })
  await UserAiPreference.create({
    userId: user.id,
    alternativeProviderId: 'openai',
    alternativeModelId: 'small',
    agentProviderId: 'openai',
    agentModelId: 'large',
  })
  await UserMcpConfiguration.create({
    userId: user.id,
    servers: [{ name: 'local', transport: 'stdio', command: 'server', disabled: false }],
  })
}

function createSubscription(userId: string) {
  return UserSubscription.create({
    userId,
    stripeCustomerId: 'cus_account_closure_test',
    stripeSubscriptionId: 'sub_account_closure_test',
    stripePriceId: 'price_account_closure_test',
    stripeCheckoutSessionId: 'cs_account_closure_test',
    status: 'active',
    currentPeriodEnd: DateTime.utc().plus({ days: 30 }),
    cancelAtPeriodEnd: false,
  })
}

function restoreUser(user: User) {
  return db.table('users').insert({
    id: user.id,
    full_name: user.fullName,
    email: user.email,
    password: user.password,
    privacy_verification_failure_count: 0,
    created_at: user.createdAt.toJSDate(),
    updated_at: user.updatedAt?.toJSDate() ?? null,
  })
}

async function assertUserDataDeleted(userId: string, ids: OwnedDataIds, assert: Assert) {
  const tables = [
    ['users', 'id'],
    ['auth_access_tokens', 'tokenable_id'],
    ['projects', 'user_id'],
    ['provider_credentials', 'user_id'],
    ['user_ai_preferences', 'user_id'],
    ['user_mcp_configurations', 'user_id'],
  ] as const
  for (const [table, column] of tables) {
    const rows = await db.from(table).where(column, userId)
    assert.lengthOf(rows, 0)
  }
  await assertOwnedRowsDeleted(ids, assert)
}

async function assertOwnedRowsDeleted(ids: OwnedDataIds, assert: Assert) {
  const rows = await Promise.all([
    db.from('project_initializations').where('project_id', ids.projectId),
    db.from('project_code_practices').where('project_id', ids.projectId),
    db.from('project_agent_memories').where('project_id', ids.projectId),
    db.from('user_stories').where('project_id', ids.projectId),
    db.from('user_story_comments').where('user_story_id', ids.storyId),
    db.from('user_story_agent_runs').where('user_story_id', ids.storyId),
    db.from('quick_chats').where('project_id', ids.projectId),
    db.from('quick_chat_messages').where('quick_chat_id', ids.chatId),
    db.from('quick_chat_agent_runs').where('quick_chat_id', ids.chatId),
  ])
  for (const records of rows) assert.lengthOf(records, 0)
}

async function assertClosureArchive(user: User, assert: Assert) {
  const closure = await AccountClosureRequest.findByOrFail('source_user_id', user.id)
  assert.equal(closure.status, 'completed')
  assert.notEqual(closure.emailFingerprint, user.email)
  assert.lengthOf(closure.emailFingerprint, 64)
  assert.isNotNull(closure.activeDeletionCompletedAt)
  assert.isNotNull(closure.externalCleanupCompletedAt)
}

function assertBillingEvidence(
  closure: AccountClosureRequest,
  subscription: UserSubscription,
  assert: Assert
) {
  assert.equal(closure.stripeCustomerId, subscription.stripeCustomerId)
  assert.equal(closure.stripeSubscriptionId, subscription.stripeSubscriptionId)
  assert.equal(closure.stripePriceId, subscription.stripePriceId)
  assert.equal(closure.stripeCheckoutSessionId, subscription.stripeCheckoutSessionId)
  assert.equal(closure.subscriptionStatus, subscription.status)
  assert.equal(closure.subscriptionCancelAtPeriodEnd, subscription.cancelAtPeriodEnd)
  assert.equal(closure.lastError, 'Error')
  assert.isNotNull(closure.activeDeletionCompletedAt)
}

class FailingOnceBillingCleanup {
  attempts = 0

  async deleteCustomer() {
    this.attempts += 1
    if (this.attempts === 1) throw new Error('Sensitive provider diagnostic')
  }
}

async function assertClosureDeadlines(receipt: ClosureReceipt, assert: Assert) {
  const requestedAt = new Date(receipt.requestedAt).getTime()
  const activeDeadline = new Date(receipt.activeDeletionDeadline).getTime()
  const deletedAt = new Date(receipt.activeDeletionCompletedAt).getTime()
  const backupDeadline = new Date(receipt.backupExpirationDeadline).getTime()
  assert.isAtMost(activeDeadline - requestedAt, 30 * 24 * 60 * 60 * 1000)
  assert.isAtMost(backupDeadline - deletedAt, 90 * 24 * 60 * 60 * 1000)
}

async function assertReceiptStatus(client: ApiClient, receipt: ClosureReceipt) {
  const statusResponse = await client.post('/api/v1/account/closure-status').json({
    requestId: receipt.requestId,
    receiptToken: receipt.receiptToken,
  })
  statusResponse.assertStatus(200)
  statusResponse.assertBodyContains({ requestId: receipt.requestId, status: 'completed' })
  statusResponse.assertHeader('cache-control', 'private, no-store')
  const invalidStatus = await client.post('/api/v1/account/closure-status').json({
    requestId: receipt.requestId,
    receiptToken: 'invalid-receipt-token-with-sufficient-length',
  })
  invalidStatus.assertStatus(404)
}

type Assert = {
  equal(actual: unknown, expected: unknown): void
  isAtMost(actual: number, expected: number): void
  isNotNull(value: unknown): void
  lengthOf(value: unknown, length: number): void
  notEqual(actual: unknown, expected: unknown): void
}

type AccountExportBody = {
  format: string
  account: { email: string }
  security: { dedicatedAuthenticationSecretsIncluded: boolean }
}

type ClosureReceipt = {
  requestId: string
  receiptToken: string
  status: string
  requestedAt: string
  activeDeletionDeadline: string
  activeDeletionCompletedAt: string
  backupExpirationDeadline: string
}

type OwnedDataIds = {
  chatId: string
  projectId: string
  storyId: string
}
