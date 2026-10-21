// How much context an agent may use: the provider's own input budget by
// default, or a cap the person picks, up to what the model itself takes
// through any provider (beyond the provider's budget it is experimental).

type ContextModel = {
  contextWindow?: number
  id: string
  maxInputTokens?: number
}

// Cline keeps this share of a window for input when only the window is known.
const windowInputRatio = 0.9

export function providerInputLimit(model: ContextModel | undefined) {
  if (!model) return undefined
  if (model.maxInputTokens && model.maxInputTokens > 0)
    return model.maxInputTokens
  if (model.contextWindow && model.contextWindow > 0)
    return Math.floor(model.contextWindow * windowInputRatio)
  return undefined
}

// The same model can take more through another provider (an API key rather
// than a ChatGPT plan, say): that is as far as a cap may go.
export function modelInputLimit(
  model: ContextModel | undefined,
  providers: { models: Record<string, ContextModel> }[]
) {
  const own = providerInputLimit(model)
  if (!model) return own
  const others = providers
    .map((provider) => providerInputLimit(provider.models[model.id]))
    .filter((limit): limit is number => limit !== undefined)
  return Math.max(own ?? 0, ...others) || undefined
}

const steps = [
  32_000, 64_000, 128_000, 200_000, 256_000, 400_000, 600_000, 800_000,
  1_000_000,
]

export type ContextLimitOption = {
  experimental: boolean
  // Undefined: the provider's own limit.
  value: number | undefined
  tokens: number
}

export function contextLimitOptions(
  providerLimit: number | undefined,
  modelLimit: number | undefined
): ContextLimitOption[] {
  if (!providerLimit) return []
  const top = Math.max(providerLimit, modelLimit ?? 0)
  const below = steps.filter((step) => step < providerLimit * 0.95)
  const above = steps.filter(
    (step) => step > providerLimit * 1.05 && step < top * 0.95
  )
  return [
    ...below.map((tokens) => ({ experimental: false, tokens, value: tokens })),
    { experimental: false, tokens: providerLimit, value: undefined },
    ...above.map((tokens) => ({ experimental: true, tokens, value: tokens })),
    ...(top > providerLimit
      ? [{ experimental: true, tokens: top, value: top }]
      : []),
  ]
}

// The cap sent to the agent: none by default, never above the model's limit.
export function effectiveContextLimit(
  choice: number | undefined,
  modelLimit: number | undefined
) {
  if (!choice) return undefined
  return modelLimit ? Math.min(choice, modelLimit) : choice
}
