import User from '#models/user'
import UserSubscription from '#models/user_subscription'
import AccountVerificationService from '#services/account_verification_service'
import type { AccountVerificationResult } from '#services/account_verification_service'
import env from '#start/env'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import type Stripe from 'stripe'
import { createStripeClient } from '#services/stripe_client'

export type ConsumerContractStripeClient = {
  subscriptions: {
    retrieve(id: string): Promise<Stripe.Subscription>
    update(id: string, params: Stripe.SubscriptionUpdateParams): Promise<Stripe.Subscription>
    cancel(id: string, params: Stripe.SubscriptionCancelParams): Promise<Stripe.Subscription>
  }
  invoicePayments: {
    list(params: Stripe.InvoicePaymentListParams): Promise<{ data: Stripe.InvoicePayment[] }>
  }
  refunds: {
    create(
      params: Stripe.RefundCreateParams,
      options: Stripe.RequestOptions
    ): Promise<Stripe.Refund>
  }
}

type ContractIdentity = {
  subscriberName: string
  accountEmail: string
  password: string
  contractReference?: string
  acknowledgementEmail: string
  deliveryMethod: 'download'
}

export type WithdrawalInput = ContractIdentity & {
  contractDate: string
}

type VerifiedContract = {
  localSubscription: UserSubscription
}

export class ConsumerContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export default class ConsumerContractService {
  constructor(
    private stripe: ConsumerContractStripeClient | null = null,
    private readonly now: () => DateTime = () => DateTime.utc()
  ) {}

  async withdraw(input: WithdrawalInput) {
    ensureValidDate(input.contractDate)
    const contract = await this.verifyContract(input)
    const remote = await this.stripeClient().subscriptions.retrieve(
      contract.localSubscription.stripeSubscriptionId!
    )
    const submittedAt = metadataDate(remote, 'blameWithdrawalRequestedAt') ?? this.now()
    ensureWithdrawalPeriod(remote, this.now())
    const reference = metadataReference(remote, 'blameWithdrawalReference', 'RET')
    const marked = await this.markWithdrawal(remote, input, reference, submittedAt)
    const refund = await this.refundLatestInvoice(marked, reference)
    const canceled = await this.cancelImmediately(marked)
    await syncLocalSubscription(contract.localSubscription, canceled)
    return withdrawalReceipt(input, canceled, refund, reference, submittedAt)
  }

  private async verifyContract(input: ContractIdentity): Promise<VerifiedContract> {
    const user = await User.findBy('email', input.accountEmail.trim().toLowerCase())
    if (!user) throw invalidContract()
    const result = await new AccountVerificationService().verifyConsumerContract(
      user,
      input.password
    )
    ensureVerified(result)
    const localSubscription = await UserSubscription.find(user.id)
    if (!localSubscription?.stripeSubscriptionId) throw invalidContract()
    ensureReferenceMatches(input.contractReference, localSubscription)
    return { localSubscription }
  }

  private markWithdrawal(
    remote: Stripe.Subscription,
    input: WithdrawalInput,
    reference: string,
    submittedAt: DateTime
  ) {
    if (remote.status === 'canceled') return remote
    return this.stripeClient().subscriptions.update(remote.id, {
      metadata: {
        blameWithdrawalReference: reference,
        blameWithdrawalRequestedAt: submittedAt.toISO()!,
        blameWithdrawalContractDate: input.contractDate,
      },
    })
  }

  private async refundLatestInvoice(subscription: Stripe.Subscription, reference: string) {
    const invoiceId = stripeId(subscription.latest_invoice)
    if (!invoiceId) return null
    const payments = await this.stripeClient().invoicePayments.list({
      invoice: invoiceId,
      status: 'paid',
    })
    const payment = latestRefundablePayment(payments.data)
    if (!payment) return null
    return this.stripeClient().refunds.create(refundParameters(payment, reference), {
      idempotencyKey: `blame-withdrawal-${subscription.id}`,
    })
  }

  private cancelImmediately(subscription: Stripe.Subscription) {
    if (subscription.status === 'canceled') return subscription
    return this.stripeClient().subscriptions.cancel(subscription.id, {
      invoice_now: false,
      prorate: false,
    })
  }

  private stripeClient() {
    this.stripe ??= configuredStripeClient()
    return this.stripe
  }
}

function configuredStripeClient(): ConsumerContractStripeClient {
  const secretKey = env.get('STRIPE_SECRET_KEY')
  if (!secretKey) throw new Error('Stripe billing is not configured')
  return createStripeClient(secretKey)
}

function invalidContract() {
  return new ConsumerContractError(
    'CONSUMER_CONTRACT_VERIFICATION_FAILED',
    'The account credentials or contract reference could not be verified',
    401
  )
}

function ensureVerified(result: AccountVerificationResult) {
  if (result === 'verified') return
  if (result === 'failed') throw invalidContract()
  throw new ConsumerContractError(
    'CONSUMER_CONTRACT_VERIFICATION_RATE_LIMITED',
    'Too many verification attempts. Try again later',
    429
  )
}

function ensureReferenceMatches(reference: string | undefined, local: UserSubscription) {
  if (!reference) return
  const matches = [local.stripeSubscriptionId, local.stripeCustomerId].includes(reference.trim())
  if (!matches) throw invalidContract()
}

function ensureValidDate(value: string) {
  if (DateTime.fromISO(value, { zone: 'utc' }).isValid) return
  throw new ConsumerContractError('INVALID_CONTRACT_DATE', 'The supplied date is invalid', 422)
}

function ensureWithdrawalPeriod(subscription: Stripe.Subscription, now: DateTime) {
  if (subscription.metadata.blameWithdrawalRequestedAt) return
  const deadline = DateTime.fromSeconds(subscription.created, { zone: 'utc' }).plus({ days: 14 })
  if (now <= deadline) return
  throw new ConsumerContractError(
    'WITHDRAWAL_PERIOD_EXPIRED',
    'The statutory fourteen-day withdrawal period has expired',
    422
  )
}

function metadataDate(subscription: Stripe.Subscription, key: string) {
  const value = subscription.metadata[key]
  if (!value) return null
  const date = DateTime.fromISO(value, { zone: 'utc' })
  return date.isValid ? date : null
}

function metadataReference(subscription: Stripe.Subscription, key: string, prefix: string) {
  return subscription.metadata[key] || `BLM-${prefix}-${randomUUID().toUpperCase()}`
}

function subscriptionEnd(subscription: Stripe.Subscription) {
  const itemEnd = subscription.items.data[0]?.current_period_end
  const timestamp = subscription.ended_at ?? subscription.cancel_at ?? itemEnd
  return timestamp ? DateTime.fromSeconds(timestamp, { zone: 'utc' }).toISO() : null
}

async function syncLocalSubscription(local: UserSubscription, remote: Stripe.Subscription) {
  const matchingItem = remote.items.data.find((item) => item.price.id === local.stripePriceId)
  const item = matchingItem ?? remote.items.data[0]
  local.merge({
    status: remote.status,
    cancelAtPeriodEnd: remote.cancel_at_period_end,
    currentPeriodEnd: item ? DateTime.fromSeconds(item.current_period_end, { zone: 'utc' }) : null,
  })
  await local.save()
}

function stripeId(value: string | { id?: string } | null) {
  if (!value) return null
  return typeof value === 'string' ? value : (value.id ?? null)
}

function latestRefundablePayment(payments: Stripe.InvoicePayment[]) {
  return payments
    .filter(
      (payment) =>
        payment.status === 'paid' &&
        (payment.amount_paid ?? 0) > 0 &&
        Boolean(
          stripeId(payment.payment.payment_intent ?? null) ||
          stripeId(payment.payment.charge ?? null)
        )
    )
    .sort((left, right) => right.created - left.created)[0]
}

function refundParameters(payment: Stripe.InvoicePayment, reference: string) {
  const paymentIntent = stripeId(payment.payment.payment_intent ?? null)
  const charge = stripeId(payment.payment.charge ?? null)
  return {
    ...(paymentIntent ? { payment_intent: paymentIntent } : { charge: charge! }),
    reason: 'requested_by_customer' as const,
    metadata: { blameWithdrawalReference: reference },
  }
}

function withdrawalReceipt(
  input: WithdrawalInput,
  subscription: Stripe.Subscription,
  refund: Stripe.Refund | null,
  reference: string,
  submittedAt: DateTime
) {
  return {
    format: 'blame-consumer-contract-receipt',
    action: 'withdrawal',
    reference,
    submittedAt: submittedAt.toISO(),
    effectiveAt: subscriptionEnd(subscription) ?? submittedAt.toISO(),
    contractDate: input.contractDate,
    subscriberName: input.subscriberName,
    acknowledgementEmail: input.acknowledgementEmail,
    contractReference: subscription.id,
    status: 'completed',
    refund: refund
      ? { id: refund.id, amount: refund.amount, currency: refund.currency, status: refund.status }
      : null,
    effects: ['The subscription is terminated', 'Account data is not deleted'],
  }
}
