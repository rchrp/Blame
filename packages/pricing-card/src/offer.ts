// The Blame Premium offer itself, without React: the pricing card shows it,
// and the website also states it in its structured data and in the Markdown
// it serves to AI agents, so every place quotes the same prices.

export const pricingBillingOptions = {
  monthly: { label: 'Monthly', price: '20', suffix: 'USD /month' },
  yearly: { label: 'Yearly', price: '200', suffix: 'USD /year' },
} as const

export type PricingBillingCycle = keyof typeof pricingBillingOptions

export const premiumBenefits = [
  'Managed cloud previews',
  'Cloud voice transcription',
  'Hosted file uploads',
  'Existing usage limits apply',
  'Cancel anytime',
] as const
