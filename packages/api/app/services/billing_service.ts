import Stripe from 'stripe'
import { createStripeClient } from '#services/stripe_client'
import env from '#start/env'
import User from '#models/user'
import UserSubscription from '#models/user_subscription'
import StripeWebhookEvent from '#models/stripe_webhook_event'
import { reuseCheckoutUrlForPrice } from '#services/checkout_session_reuse'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

export type BillingCycle = 'monthly' | 'yearly'

const licensedStatuses = new Set(['active', 'trialing'])

export default class BillingService {
  private stripeClient() {
    const secretKey = env.get('STRIPE_SECRET_KEY')
    if (!secretKey) throw new Error('Stripe billing is not configured')
    return createStripeClient(secretKey)
  }

  private config(
    name:
      | 'STRIPE_MONTHLY_PRICE_ID'
      | 'STRIPE_YEARLY_PRICE_ID'
      | 'STRIPE_CHECKOUT_SUCCESS_URL'
      | 'STRIPE_CHECKOUT_CANCEL_URL'
      | 'STRIPE_PORTAL_RETURN_URL'
      | 'STRIPE_WEBHOOK_SECRET'
  ) {
    const value = env.get(name)
    if (!value) throw new Error('Stripe billing is not configured')
    return value
  }

  async status(userId: string) {
    const subscription = await UserSubscription.find(userId)
    const periodIsCurrent =
      !subscription?.currentPeriodEnd || subscription.currentPeriodEnd > DateTime.utc()
    return {
      licensed: Boolean(
        subscription && licensedStatuses.has(subscription.status) && periodIsCurrent
      ),
      status: subscription?.status ?? 'inactive',
      currentPeriodEnd: subscription?.currentPeriodEnd?.toISO() ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    }
  }

  async reconcile(userId: string) {
    const local = await UserSubscription.find(userId)
    if (!local) return this.status(userId)
    const requestedAt = Math.floor(Date.now() / 1000)

    const subscriptions = await this.stripeClient().subscriptions.list({
      customer: local.stripeCustomerId,
      status: 'all',
      limit: 100,
    })
    const allowedPrices = new Set([
      this.config('STRIPE_MONTHLY_PRICE_ID'),
      this.config('STRIPE_YEARLY_PRICE_ID'),
    ])
    const matching = subscriptions.data
      .map((subscription) => ({
        subscription,
        item: subscription.items.data.find((item) => allowedPrices.has(item.price.id)),
      }))
      .filter(
        (
          candidate
        ): candidate is { subscription: Stripe.Subscription; item: Stripe.SubscriptionItem } =>
          candidate.item !== undefined
      )
      .sort((left, right) => {
        const now = DateTime.utc().toSeconds()
        const leftLicensed =
          licensedStatuses.has(left.subscription.status) && left.item.current_period_end > now
            ? 1
            : 0
        const rightLicensed =
          licensedStatuses.has(right.subscription.status) && right.item.current_period_end > now
            ? 1
            : 0
        return (
          rightLicensed - leftLicensed || right.subscription.created - left.subscription.created
        )
      })[0]

    await db.transaction(async (trx) => {
      const locked = await UserSubscription.query({ client: trx })
        .where('user_id', userId)
        .forUpdate()
        .firstOrFail()
      if ((locked.lastStripeEventCreatedAt ?? 0) > requestedAt) return
      if (matching) {
        await this.applySubscription(locked, matching.subscription, undefined, trx)
        return
      }
      locked.useTransaction(trx)
      locked.merge({
        stripeSubscriptionId: null,
        stripePriceId: null,
        status: 'inactive',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      })
      await locked.save()
    })
    return this.status(userId)
  }

  async createCheckout(user: User, cycle: BillingCycle) {
    const price = this.config(
      cycle === 'monthly' ? 'STRIPE_MONTHLY_PRICE_ID' : 'STRIPE_YEARLY_PRICE_ID'
    )
    const subscription = await this.ensureCustomer(user)
    if (licensedStatuses.has(subscription.status)) {
      throw new Error('An active subscription already exists')
    }
    return this.createCheckoutSession(user.id, price)
  }

  private ensureCustomer(user: User) {
    return db.transaction(async (transaction) => {
      await this.lockActiveUser(user.id, transaction)
      const existing = await UserSubscription.query({ client: transaction })
        .where('user_id', user.id)
        .first()
      if (existing) return existing
      const customer = await this.stripeClient().customers.create(customerInput(user), {
        idempotencyKey: `blame-customer-${user.id}`,
      })
      return UserSubscription.create(
        { userId: user.id, stripeCustomerId: customer.id, status: 'inactive' },
        { client: transaction }
      )
    })
  }

  private createCheckoutSession(userId: string, price: string) {
    return db.transaction(async (transaction) => {
      await this.lockActiveUser(userId, transaction)
      const subscription = await UserSubscription.query({ client: transaction })
        .where('user_id', userId)
        .forUpdate()
        .firstOrFail()
      if (subscription.stripeCheckoutSessionId) {
        const existingUrl = await reuseCheckoutUrlForPrice(
          this.stripeClient().checkout.sessions,
          subscription.stripeCheckoutSessionId,
          price
        )
        if (existingUrl) return existingUrl
      }

      const session = await this.createStripeCheckoutSession(subscription, userId, price)
      if (!session.url) throw new Error('Stripe did not return a checkout URL')
      subscription.useTransaction(transaction)
      subscription.stripeCheckoutSessionId = session.id
      await subscription.save()
      return session.url
    })
  }

  private createStripeCheckoutSession(
    subscription: UserSubscription,
    userId: string,
    price: string
  ) {
    return this.stripeClient().checkout.sessions.create({
      mode: 'subscription',
      integration_identifier: 'blame-subscription-hvytpmqx',
      customer: subscription.stripeCustomerId,
      client_reference_id: userId,
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: false,
      success_url: this.config('STRIPE_CHECKOUT_SUCCESS_URL'),
      cancel_url: this.config('STRIPE_CHECKOUT_CANCEL_URL'),
      // Clover changed the default to flexible; preserve existing billing behavior.
      subscription_data: { billing_mode: { type: 'classic' }, metadata: { blameUserId: userId } },
    })
  }

  private async lockActiveUser(userId: string, transaction: Parameters<User['useTransaction']>[0]) {
    const user = await User.query({ client: transaction }).where('id', userId).forUpdate().first()
    if (!user || user.closureRequestedAt) throw new Error('This account is closing')
    return user
  }

  async createPortal(userId: string) {
    const subscription = await UserSubscription.findOrFail(userId)
    const session = await this.stripeClient().billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: this.config('STRIPE_PORTAL_RETURN_URL'),
    })
    return session.url
  }

  async deleteCustomer(customerId: string) {
    try {
      await this.stripeClient().customers.del(customerId)
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode === 404) {
        return
      }
      throw error
    }
  }

  constructEvent(payload: string, signature: string) {
    return this.stripeClient().webhooks.constructEvent(
      payload,
      signature,
      this.config('STRIPE_WEBHOOK_SECRET')
    )
  }

  async processEvent(event: Stripe.Event) {
    await db.transaction(async (trx) => {
      const processed = await StripeWebhookEvent.query({ client: trx })
        .where('id', event.id)
        .first()
      if (processed) return

      if (event.type.startsWith('customer.subscription.')) {
        const stripeSubscription = event.data.object as Stripe.Subscription
        const customerId =
          typeof stripeSubscription.customer === 'string'
            ? stripeSubscription.customer
            : stripeSubscription.customer.id
        const local = await UserSubscription.query({ client: trx })
          .where('stripe_customer_id', customerId)
          .forUpdate()
          .first()
        if (local) {
          if (
            local.lastStripeEventCreatedAt !== null &&
            event.created < local.lastStripeEventCreatedAt
          ) {
            await StripeWebhookEvent.create({ id: event.id, type: event.type }, { client: trx })
            return
          }
          const allowed = stripeSubscription.items.data.some(
            (item) =>
              item.price.id === this.config('STRIPE_MONTHLY_PRICE_ID') ||
              item.price.id === this.config('STRIPE_YEARLY_PRICE_ID')
          )
          if (allowed) await this.applySubscription(local, stripeSubscription, event.created, trx)
        }
      }

      await StripeWebhookEvent.create({ id: event.id, type: event.type }, { client: trx })
    })
  }

  private async applySubscription(
    local: UserSubscription,
    stripeSubscription: Stripe.Subscription,
    eventCreatedAt?: number,
    trx?: Parameters<UserSubscription['useTransaction']>[0]
  ) {
    const item = stripeSubscription.items.data.find(
      (candidate) =>
        candidate.price.id === this.config('STRIPE_MONTHLY_PRICE_ID') ||
        candidate.price.id === this.config('STRIPE_YEARLY_PRICE_ID')
    )
    if (trx) local.useTransaction(trx)
    local.merge({
      stripeSubscriptionId: stripeSubscription.id,
      stripePriceId: item?.price.id ?? null,
      status: item ? stripeSubscription.status : 'inactive',
      currentPeriodEnd: item ? DateTime.fromSeconds(item.current_period_end) : null,
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
      ...(eventCreatedAt === undefined ? {} : { lastStripeEventCreatedAt: eventCreatedAt }),
    })
    await local.save()
  }
}

function customerInput(user: User) {
  return {
    email: user.email,
    name: user.fullName ?? undefined,
    metadata: { blameUserId: user.id },
  }
}
