import vine from '@vinejs/vine'
import { engineProviderId } from '#validators/provider_id'

const practice = vine.enum([
  'coding_style',
  'unit_tests',
  'layered_architecture',
  'commit_message_convention',
])

export const startProjectCodePracticeAnalysisValidator = vine.create({
  providerId: engineProviderId,
  modelId: vine.string().trim().minLength(1).maxLength(255),
})

export const completeProjectCodePracticeAnalysisValidator = vine.create({
  clineSessionId: vine.string().trim().maxLength(255).nullable().optional(),
  practices: vine
    .array(
      vine.object({
        practice,
        detected: vine.boolean(),
        comment: vine.string().trim().minLength(1).maxLength(2048),
      })
    )
    .minLength(4)
    .maxLength(4),
})

export const failProjectCodePracticeAnalysisValidator = vine.create({
  clineSessionId: vine.string().trim().maxLength(255).nullable().optional(),
  error: vine.string().trim().minLength(1).maxLength(4096),
})
