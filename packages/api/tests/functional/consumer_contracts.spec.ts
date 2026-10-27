import User from '#models/user'
import UserSubscription from '#models/user_subscription'
import ConsumerContractService from '#services/consumer_contract_service'
import { ConsumerContractError } from '#services/consumer_contract_service'
import type { ConsumerContractStripeClient } from '#services/consumer_contract_service'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import type Stripe from 'stripe'

const password = 'password123'
const now = DateTime.fromISO('2026-07-19T10:00:00.000Z')

test.group('consumer contract actions', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('withdraws an eligible contract, refunds and cancels immediately', async ({ assert }) => {
    const user = await createSubscribedUser()
    const stripe = new FakeContractStripe(subscriptionFixture())
    const service = new ConsumerContractService(stripe, () => now)
    const receipt = await service.withdraw(withdrawalInput(user.email))

    assert.equal(receipt.action, 'withdrawal')
    assert.equal(receipt.status, 'completed')
    assert.equal(receipt.refund?.amount, 1300)
    assert.match(receipt.reference, /^BLM-RET-/)
    assert.equal(stripe.subscription.status, 'canceled')
    assert.equal(stripe.refundRequests, 1)
    const local = await UserSubscription.findOrFail(user.id)
    assert.equal(local.status, 'canceled')
  })

  test('rejects withdrawal after the fourteen-day period', async ({ assert }) => {
    const user = await createSubscribedUser()
    const remote = subscriptionFixture(now.minus({ days: 15 }).toSeconds())
    const service = new ConsumerContractService(new FakeContractStripe(remote), () => now)

    try {
      await service.withdraw(withdrawalInput(user.email))
      assert.fail('Expected the withdrawal request to be rejected')
    } catch (error) {
      assert.instanceOf(error, ConsumerContractError)
      assert.equal((error as ConsumerContractError).code, 'WITHDRAWAL_PERIOD_EXPIRED')
    }
  })

  test('verifies credentials before accessing Stripe', async ({ client }) => {
    const user = await createSubscribedUser()
    const response = await client.post('/api/v1/consumer-contract/withdrawal').json({
      ...withdrawalInput(user.email),
      password: 'incorrect-password',
      confirmation: 'confirmer-la-retractation',
      deliveryMethod: 'download',
    })

    response.assertStatus(401)
    response.assertBodyContains({ code: 'CONSUMER_CONTRACT_VERIFICATION_FAILED' })
    response.assertHeader('cache-control', 'private, no-store')
  })
})

class FakeContractStripe implements ConsumerContractStripeClient {
  refundRequests = 0

  constructor(public subscription: Stripe.Subscription) {}

  subscriptions = {
    retrieve: async (_id: string) => this.subscription,
    update: async (_id: string, params: Stripe.SubscriptionUpdateParams) => {
      this.subscription = {
        ...this.subscription,
        cancel_at_period_end: params.cancel_at_period_end ?? this.subscription.cancel_at_period_end,
        cancel_at: params.cancel_at_period_end
          ? this.subscription.items.data[0]!.current_period_end
          : this.subscription.cancel_at,
        metadata: {
          ...this.subscription.metadata,
          ...((params.metadata ?? {}) as Stripe.Metadata),
        },
      }
      return this.subscription
    },
    cancel: async (_id: string, _params: Stripe.SubscriptionCancelParams) => {
      this.subscription = {
        ...this.subscription,
        status: 'canceled',
        canceled_at: Math.floor(now.toSeconds()),
        ended_at: Math.floor(now.toSeconds()),
        cancel_at_period_end: false,
      }
      return this.subscription
    },
  }

  invoicePayments = {
    list: async (_params: Stripe.InvoicePaymentListParams) => ({
      data: [invoicePaymentFixture()],
    }),
  }

  refunds = {
    create: async (_params: Stripe.RefundCreateParams, _options: Stripe.RequestOptions) => {
      this.refundRequests += 1
      return refundFixture()
    },
  }
}

async function createSubscribedUser() {
  const user = await User.create({
    email: `${crypto.randomUUID()}@example.com`,
    fullName: 'Consumer Tester',
    password,
  })
  await UserSubscription.create({
    userId: user.id,
    stripeCustomerId: 'cus_consumer',
    stripeSubscriptionId: 'sub_consumer',
    stripePriceId: 'price_monthly',
    status: 'active',
    currentPeriodEnd: now.plus({ days: 20 }),
    cancelAtPeriodEnd: false,
  })
  return user
}

function withdrawalInput(email: string) {
  return {
    subscriberName: 'Consumer Tester',
    accountEmail: email,
    password,
    acknowledgementEmail: email,
    deliveryMethod: 'download' as const,
    contractDate: '2026-07-17',
  }
}

function subscriptionFixture(created = now.minus({ days: 2 }).toSeconds()) {
  return {
    id: 'sub_consumer',
    object: 'subscription',
    created: Math.floor(created),
    status: 'active',
    metadata: {},
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    cancel_at_period_end: false,
    latest_invoice: 'in_consumer',
    items: {
      object: 'list',
      data: [
        {
          id: 'si_consumer',
          price: { id: 'price_monthly' },
          current_period_end: Math.floor(now.plus({ days: 20 }).toSeconds()),
        },
      ],
      has_more: false,
      url: '/v1/subscription_items',
    },
  } as Stripe.Subscription
}

function invoicePaymentFixture() {
  return {
    id: 'inpay_consumer',
    object: 'invoice_payment',
    amount_paid: 1300,
    amount_requested: 1300,
    created: Math.floor(now.minus({ days: 2 }).toSeconds()),
    currency: 'eur',
    invoice: 'in_consumer',
    is_default: true,
    livemode: false,
    payment: { type: 'payment_intent', payment_intent: 'pi_consumer' },
    status: 'paid',
    status_transitions: { canceled_at: null, paid_at: Math.floor(now.toSeconds()) },
  } as Stripe.InvoicePayment
}

function refundFixture() {
  return {
    id: 're_consumer',
    object: 'refund',
    amount: 1300,
    currency: 'eur',
    status: 'succeeded',
  } as Stripe.Refund
}
