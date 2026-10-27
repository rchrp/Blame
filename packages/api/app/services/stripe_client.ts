import Stripe from 'stripe'

// Keep billing and withdrawal requests on the same explicitly reviewed API.
export const stripeApiVersion = '2026-09-30.endive'

export function createStripeClient(secretKey: string, options: Stripe.StripeConfig = {}) {
  return new Stripe(secretKey, { ...options, apiVersion: stripeApiVersion })
}
