import AccountClosureRequest from '#models/account_closure_request'
import User from '#models/user'
import UserSubscription from '#models/user_subscription'
import AccountClosureLedgerService from '#services/account_closure_ledger_service'
import type { AccountClosureLedgerRecord } from '#services/account_closure_ledger_service'
import BillingService from '#services/billing_service'
import EngineSessionsService from '#services/engine_sessions_service'
import FileAttachmentsService from '#services/file_attachments_service'
import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { DateTime } from 'luxon'

const activeDeletionLimitDays = 30
const backupRotationDays = 90
const rightsRequestArchiveYears = 5
const billingArchiveYears = 10
const retryDelayHours = 1
const processingLeaseMinutes = 15

type BillingCleanup = Pick<BillingService, 'deleteCustomer'>

export default class AccountClosureService {
  constructor(
    private billingCleanup: BillingCleanup = new BillingService(),
    private closureLedger = new AccountClosureLedgerService()
  ) {}

  async close(user: User) {
    const scheduled = await this.schedule(user)
    await this.process(scheduled.closure.id)
    const closure = await AccountClosureRequest.findOrFail(scheduled.closure.id)
    return closureReceipt(closure, scheduled.receiptToken)
  }

  async status(requestId: string, receiptToken: string) {
    const closure = await AccountClosureRequest.find(requestId)
    if (!closure || !validReceiptToken(closure, receiptToken)) return null
    return closureReceipt(closure, null)
  }

  async retryPending(limit = 100) {
    const now = DateTime.utc()
    const leaseThreshold = now.minus({ minutes: processingLeaseMinutes })
    const closures = await AccountClosureRequest.query()
      .whereNot('status', 'completed')
      .where((query) =>
        query.whereNull('next_retry_at').orWhere('next_retry_at', '<=', now.toJSDate())
      )
      .where((query) =>
        query
          .whereNull('processing_started_at')
          .orWhere('processing_started_at', '<=', leaseThreshold.toJSDate())
      )
      .orderBy('active_deletion_deadline', 'asc')
      .limit(limit)

    for (const closure of closures) await this.process(closure.id)
    return closures
  }

  async retryAllPending(batchSize = 100) {
    let retried = 0
    while (true) {
      const closures = await this.retryPending(batchSize)
      retried += closures.length
      if (closures.length < batchSize) return retried
    }
  }

  async reconcileLedger() {
    const records = await this.closureLedger.records()
    let reconciled = 0
    for (const record of records) {
      const requestId = await this.restoreLedgerRecord(record)
      if (!requestId) continue
      reconciled += 1
      await this.process(requestId)
    }
    return reconciled
  }

  async deleteExpiredArchives() {
    const closures = await AccountClosureRequest.query()
      .where('retain_until', '<=', DateTime.utc().toJSDate())
      .where('status', 'completed')
    for (const closure of closures) await this.closureLedger.delete(closure.sourceUserId)
    if (closures.length === 0) return 0
    return AccountClosureRequest.query()
      .whereIn(
        'id',
        closures.map((closure) => closure.id)
      )
      .delete()
  }

  private async process(requestId: string) {
    const closure = await this.claim(requestId)
    if (!closure) return
    try {
      if (!(await this.ensureLedgerRecorded(closure))) return
      if (!closure.externalCleanupCompletedAt) await this.attemptExternalCleanup(closure)
      if (!closure.activeDeletionCompletedAt) await this.attemptActiveDeletion(closure)
      await closure.refresh()
      await this.saveProgress(closure)
    } finally {
      await this.release(requestId)
    }
  }

  private async ensureLedgerRecorded(closure: AccountClosureRequest) {
    if (closure.ledgerRecordedAt) return true
    try {
      await this.closureLedger.write(closure)
      closure.ledgerRecordedAt = DateTime.utc()
      await closure.save()
      return true
    } catch (error) {
      await this.markFailure(closure, error)
      return false
    }
  }

  private claim(requestId: string) {
    return db.transaction(async (transaction) => {
      const closure = await AccountClosureRequest.query({ client: transaction })
        .where('id', requestId)
        .forUpdate()
        .first()
      if (!closure || leaseIsActive(closure)) return null
      closure.useTransaction(transaction)
      closure.processingStartedAt = DateTime.utc()
      await closure.save()
      return closure
    })
  }

  private release(requestId: string) {
    return AccountClosureRequest.query()
      .where('id', requestId)
      .update({ processingStartedAt: null })
  }

  private schedule(user: User) {
    return db.transaction(async (transaction) => {
      const lockedUser = await User.query({ client: transaction })
        .where('id', user.id)
        .forUpdate()
        .first()
      const existing = await AccountClosureRequest.query({ client: transaction })
        .where('source_user_id', user.id)
        .first()
      if (existing) return { closure: existing, receiptToken: null }
      if (!lockedUser) throw new Error('Account closure request has no active account')

      const now = DateTime.utc()
      const subscription = await UserSubscription.query({ client: transaction })
        .where('user_id', user.id)
        .first()
      const receiptToken = randomBytes(32).toString('base64url')
      const closure = await this.createClosure(
        lockedUser,
        subscription,
        now,
        transaction,
        receiptToken
      )
      await this.markUserClosing(lockedUser, closure, transaction)
      return { closure, receiptToken }
    })
  }

  private restoreLedgerRecord(record: AccountClosureLedgerRecord) {
    return db.transaction(async (transaction) => {
      const user = await User.query({ client: transaction })
        .where('id', record.sourceUserId)
        .forUpdate()
        .first()
      if (!user) return null
      let closure = await AccountClosureRequest.query({ client: transaction })
        .where('source_user_id', record.sourceUserId)
        .forUpdate()
        .first()
      if (!closure) {
        closure = await AccountClosureRequest.create(closureFromLedger(record), {
          client: transaction,
        })
      } else {
        closure.useTransaction(transaction)
        closure.merge(restoredClosureState())
        await closure.save()
      }
      await this.markUserClosing(user, closure, transaction)
      return closure.id
    })
  }

  private createClosure(
    user: User,
    subscription: UserSubscription | null,
    requestedAt: DateTime,
    transaction: Parameters<AccountClosureRequest['useTransaction']>[0],
    receiptToken: string
  ) {
    return AccountClosureRequest.create(
      closureRecord(user, subscription, requestedAt, receiptToken),
      { client: transaction }
    )
  }

  private async markUserClosing(
    user: User,
    closure: AccountClosureRequest,
    transaction: Parameters<User['useTransaction']>[0]
  ) {
    user.useTransaction(transaction)
    user.merge({
      closureRequestedAt: closure.requestedAt,
      activeDeletionDeadline: closure.activeDeletionDeadline,
    })
    await user.save()
  }

  private async attemptExternalCleanup(closure: AccountClosureRequest) {
    if (!closure.stripeCustomerId) {
      await this.markExternalCleanupComplete(closure)
      return
    }
    try {
      await this.billingCleanup.deleteCustomer(closure.stripeCustomerId)
      await this.markExternalCleanupComplete(closure)
    } catch (error) {
      await this.markFailure(closure, error)
    }
  }

  private async attemptActiveDeletion(closure: AccountClosureRequest) {
    try {
      await deleteActiveUser(closure.sourceUserId)
      const completedAt = DateTime.utc()
      closure.activeDeletionCompletedAt = completedAt
      closure.activeDeletionDeadlineBreachedAt =
        completedAt > closure.activeDeletionDeadline ? completedAt : null
      closure.backupExpirationDeadline = completedAt.plus({ days: backupRotationDays })
      await this.saveProgress(closure)
    } catch (error) {
      await this.markFailure(closure, error)
    }
  }

  private async markExternalCleanupComplete(closure: AccountClosureRequest) {
    closure.externalCleanupCompletedAt = DateTime.utc()
    await this.saveProgress(closure)
  }

  private async saveProgress(closure: AccountClosureRequest) {
    closure.status = closureStatus(closure)
    if (closure.status === 'completed') {
      closure.lastError = null
      closure.nextRetryAt = null
    }
    await closure.save()
  }

  private async markFailure(closure: AccountClosureRequest, error: unknown) {
    const failureCode = errorCode(error)
    logger.error(
      { closureRequestId: closure.id, err: error, failureCode },
      'Account closure cleanup failed'
    )
    closure.status = closureStatus(closure)
    closure.retryCount += 1
    closure.lastError = failureCode
    closure.nextRetryAt = DateTime.utc().plus({ hours: retryDelayHours })
    await closure.save()
  }
}

function closureRecord(
  user: User,
  subscription: UserSubscription | null,
  requestedAt: DateTime,
  receiptToken: string
) {
  return {
    sourceUserId: user.id,
    emailFingerprint: emailFingerprint(user.email),
    receiptTokenHash: tokenHash(receiptToken),
    ...billingRecord(subscription),
    status: 'pending_active_deletion' as const,
    retryCount: 0,
    requestedAt,
    activeDeletionDeadline: requestedAt.plus({ days: activeDeletionLimitDays }),
    retainUntil: requestedAt.plus({ years: archiveYears(subscription) }),
  }
}

function closureFromLedger(record: AccountClosureLedgerRecord) {
  return {
    id: record.requestId,
    sourceUserId: record.sourceUserId,
    emailFingerprint: record.emailFingerprint,
    receiptTokenHash: record.receiptTokenHash,
    ...ledgerBillingRecord(record),
    status: 'pending_active_deletion' as const,
    retryCount: 0,
    requestedAt: DateTime.fromISO(record.requestedAt),
    activeDeletionDeadline: DateTime.fromISO(record.activeDeletionDeadline),
    retainUntil: DateTime.fromISO(record.retainUntil),
    ledgerRecordedAt: DateTime.utc(),
  }
}

function restoredClosureState() {
  return {
    status: 'pending_active_deletion' as const,
    activeDeletionCompletedAt: null,
    activeDeletionDeadlineBreachedAt: null,
    backupExpirationDeadline: null,
    nextRetryAt: null,
    processingStartedAt: null,
    ledgerRecordedAt: DateTime.utc(),
  }
}

function billingRecord(subscription: UserSubscription | null) {
  return {
    stripeCustomerId: subscription?.stripeCustomerId ?? null,
    stripeSubscriptionId: subscription?.stripeSubscriptionId ?? null,
    stripePriceId: subscription?.stripePriceId ?? null,
    stripeCheckoutSessionId: subscription?.stripeCheckoutSessionId ?? null,
    subscriptionStatus: subscription?.status ?? null,
    subscriptionCurrentPeriodEnd: subscription?.currentPeriodEnd ?? null,
    subscriptionCancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? null,
    subscriptionCreatedAt: subscription?.createdAt ?? null,
    subscriptionUpdatedAt: subscription?.updatedAt ?? null,
  }
}

function ledgerBillingRecord(record: AccountClosureLedgerRecord) {
  return {
    stripeCustomerId: record.stripeCustomerId,
    stripeSubscriptionId: record.stripeSubscriptionId,
    stripePriceId: record.stripePriceId,
    stripeCheckoutSessionId: record.stripeCheckoutSessionId,
    subscriptionStatus: record.subscriptionStatus,
    subscriptionCurrentPeriodEnd: optionalDate(record.subscriptionCurrentPeriodEnd),
    subscriptionCancelAtPeriodEnd: record.subscriptionCancelAtPeriodEnd,
    subscriptionCreatedAt: optionalDate(record.subscriptionCreatedAt),
    subscriptionUpdatedAt: optionalDate(record.subscriptionUpdatedAt),
  }
}

async function deleteActiveUser(userId: string) {
  await new FileAttachmentsService().deleteAllForUser(userId)
  await new EngineSessionsService().deleteAllBlobsForUser(userId)
  await db.transaction(async (transaction) => {
    const user = await User.query({ client: transaction }).where('id', userId).forUpdate().first()
    if (!user) return
    user.useTransaction(transaction)
    await user.delete()
  })
}

function leaseIsActive(closure: AccountClosureRequest) {
  if (!closure.processingStartedAt) return false
  return closure.processingStartedAt > DateTime.utc().minus({ minutes: processingLeaseMinutes })
}

function closureStatus(closure: AccountClosureRequest) {
  if (!closure.activeDeletionCompletedAt) return 'pending_active_deletion' as const
  if (!closure.externalCleanupCompletedAt) return 'pending_external_cleanup' as const
  return 'completed' as const
}

function closureReceipt(closure: AccountClosureRequest, receiptToken: string | null) {
  return {
    requestId: closure.id,
    receiptToken,
    status: closure.status,
    requestedAt: closure.requestedAt.toISO(),
    activeDeletionDeadline: closure.activeDeletionDeadline.toISO(),
    activeDeletionCompletedAt: closure.activeDeletionCompletedAt?.toISO() ?? null,
    backupExpirationDeadline: closure.backupExpirationDeadline?.toISO() ?? null,
    statusEndpoint: '/api/v1/account/closure-status',
    supportContact: 'privacy@blame.so',
  }
}

function validReceiptToken(closure: AccountClosureRequest, receiptToken: string) {
  if (!closure.receiptTokenHash) return false
  const expectedHash = Buffer.from(closure.receiptTokenHash, 'hex')
  const receivedHash = Buffer.from(tokenHash(receiptToken), 'hex')
  return expectedHash.length === receivedHash.length && timingSafeEqual(expectedHash, receivedHash)
}

function tokenHash(receiptToken: string) {
  return createHash('sha256').update(receiptToken).digest('hex')
}

function emailFingerprint(email: string) {
  return createHmac('sha256', env.get('APP_KEY').release())
    .update(email.trim().toLowerCase())
    .digest('hex')
}

function archiveYears(subscription: UserSubscription | null) {
  return subscription ? billingArchiveYears : rightsRequestArchiveYears
}

function errorCode(error: unknown) {
  if (!(error instanceof Error)) return 'UnknownError'
  const normalizedName = error.name.replace(/[^A-Za-z0-9_.-]/g, '')
  return normalizedName.slice(0, 128) || 'Error'
}

function optionalDate(value: string | null) {
  return value ? DateTime.fromISO(value) : null
}
