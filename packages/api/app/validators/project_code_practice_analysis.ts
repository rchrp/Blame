import vine from '@vinejs/vine'

const practice = vine.enum([
  'coding_style',
  'unit_tests',
  'layered_architecture',
  'commit_message_convention',
])

export const startProjectCodePracticeAnalysisValidator = vine.create({
  providerId: vine.string().trim().minLength(1).maxLength(80),
  modelId: vine.string().trim().minLength(1).maxLength(255),
})

export const completeProjectCodePracticeAnalysisValidator = vine.create({
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
  error: vine.string().trim().minLength(1).maxLength(4096),
})
