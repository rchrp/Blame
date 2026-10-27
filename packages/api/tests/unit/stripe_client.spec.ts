import { createStripeClient, stripeApiVersion } from '#services/stripe_client'
import { test } from '@japa/runner'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

test.group('Stripe SDK compatibility', () => {
  test('sends the reviewed API version on actual SDK requests', async ({ assert }) => {
    let receivedVersion: string | string[] | undefined
    const server = createServer((request, response) => {
      receivedVersion = request.headers['stripe-version']
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ id: 'cus_test', object: 'customer' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const stripe = createStripeClient('sk_test_local_fixture', {
        host: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        protocol: 'http',
        maxNetworkRetries: 0,
      })
      const customer = await stripe.customers.retrieve('cus_test')
      assert.equal(customer.id, 'cus_test')
      assert.equal(receivedVersion, stripeApiVersion)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  for (const apiVersion of ['2025-08-27.basil', stripeApiVersion]) {
    test(`accepts signed snapshot webhooks from ${apiVersion}`, ({ assert }) => {
      const stripe = createStripeClient('sk_test_local_fixture')
      const secret = 'whsec_local_fixture'
      const payload = JSON.stringify({
        id: 'evt_test',
        object: 'event',
        api_version: apiVersion,
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_test', object: 'subscription', status: 'active' } },
      })
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret })
      const event = stripe.webhooks.constructEvent(payload, signature, secret)
      assert.equal(event.api_version, apiVersion)
      assert.deepEqual(event.data.object, {
        id: 'sub_test',
        object: 'subscription',
        status: 'active',
      })
      assert.throws(() => stripe.webhooks.constructEvent(`${payload} `, signature, secret))
    })
  }
})
