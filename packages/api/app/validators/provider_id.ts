import vine from '@vinejs/vine'

/**
 * The providers the agent engine serves, by its ids
 * (`crates/blame-engine-providers/src/registry.rs`): the only ones a person
 * can connect or pick a model from.
 */
export const engineProviderIds = [
  'anthropic',
  'claude-code',
  'openai',
  'chatgpt',
  'gemini',
  'openrouter',
  'openai-compatible',
] as const

export type EngineProviderId = (typeof engineProviderIds)[number]

export const engineProviderId = vine.enum(engineProviderIds)
