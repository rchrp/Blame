type CheckoutSession = {
  id: string
  line_items?: {
    data: Array<{
      price: { id: string } | null
    }>
  }
  // Stripe enums can gain new values without a major SDK release.
  status: string | null
  url: string | null
}

export type CheckoutSessionGateway = {
  expire(sessionId: string): Promise<unknown>
  retrieve(sessionId: string, parameters: { expand: string[] }): Promise<CheckoutSession>
}

export async function reuseCheckoutUrlForPrice(
  sessions: CheckoutSessionGateway,
  sessionId: string,
  priceId: string
) {
  const session = await sessions.retrieve(sessionId, { expand: ['line_items'] })
  if (session.status !== 'open') return null
  if (session.url && containsPrice(session, priceId)) return session.url
  await sessions.expire(session.id)
  return null
}

function containsPrice(session: CheckoutSession, priceId: string) {
  return session.line_items?.data.some((lineItem) => lineItem.price?.id === priceId) ?? false
}
