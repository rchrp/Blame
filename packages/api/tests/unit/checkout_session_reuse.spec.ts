import {
  reuseCheckoutUrlForPrice,
  type CheckoutSessionGateway,
} from '#services/checkout_session_reuse'
import { test } from '@japa/runner'

test.group('checkout session reuse', () => {
  test('reuses an open checkout with the requested price', async ({ assert }) => {
    const sessions = new FakeCheckoutSessions('price_monthly')

    const url = await reuseCheckoutUrlForPrice(sessions, 'cs_monthly', 'price_monthly')

    assert.equal(url, 'https://checkout.stripe.test/cs_monthly')
    assert.deepEqual(sessions.expiredSessionIds, [])
  })

  for (const status of ['complete', 'expired', 'future_status', null]) {
    test(`does not reuse or expire a checkout with status ${status}`, async ({ assert }) => {
      const sessions = new FakeCheckoutSessions('price_monthly', status)
      assert.isNull(await reuseCheckoutUrlForPrice(sessions, 'cs_monthly', 'price_monthly'))
      assert.deepEqual(sessions.expiredSessionIds, [])
    })
  }

  test('expires an open checkout when switching billing cycles', async ({ assert }) => {
    const monthlyCheckout = new FakeCheckoutSessions('price_monthly')
    const yearlyCheckout = new FakeCheckoutSessions('price_yearly')

    const yearlyUrl = await reuseCheckoutUrlForPrice(monthlyCheckout, 'cs_monthly', 'price_yearly')
    const monthlyUrl = await reuseCheckoutUrlForPrice(yearlyCheckout, 'cs_yearly', 'price_monthly')

    assert.isNull(yearlyUrl)
    assert.isNull(monthlyUrl)
    assert.deepEqual(monthlyCheckout.expiredSessionIds, ['cs_monthly'])
    assert.deepEqual(yearlyCheckout.expiredSessionIds, ['cs_yearly'])
  })
})

class FakeCheckoutSessions implements CheckoutSessionGateway {
  expiredSessionIds: string[] = []

  constructor(
    private priceId: string,
    private status: string | null = 'open'
  ) {}

  async retrieve(sessionId: string, _parameters: { expand: string[] }) {
    return {
      id: sessionId,
      line_items: {
        data: [{ price: { id: this.priceId } }],
      },
      status: this.status,
      url: `https://checkout.stripe.test/${sessionId}`,
    }
  }

  async expire(sessionId: string) {
    this.expiredSessionIds.push(sessionId)
  }
}
