import vine from '@vinejs/vine'

const reasoningEffort = vine
  .enum(['none', 'enabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  .nullable()
const credentialLabel = vine.string().trim().nullable()

export const personalizationValues = {
  responseStyle: ['concise', 'balanced', 'detailed'],
  experience: ['new', 'comfortable', 'experienced'],
  autonomy: ['ask', 'balanced', 'decide'],
  ambition: ['quick', 'standard', 'ambitious'],
} as const

const personalization = vine.object({
  responseStyle: vine.enum(personalizationValues.responseStyle),
  experience: vine.enum(personalizationValues.experience),
  autonomy: vine.enum(personalizationValues.autonomy),
  ambition: vine.enum(personalizationValues.ambition),
})
const modelPreference = vine.object({
  providerId: vine.string().trim().minLength(1),
  modelId: vine.string().trim().minLength(1),
  credentialLabel,
  reasoningEffort,
})

export const saveUserAiPreferenceValidator = vine.create({
  alternativeModel: modelPreference.clone().optional(),
  agentModel: modelPreference.clone().optional(),
  personalization: personalization.clone().optional(),
})
