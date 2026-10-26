import vine from '@vinejs/vine'

export const webSearchValidator = vine.compile(
  vine.object({
    query: vine.string().trim().minLength(2).maxLength(500),
    limit: vine.number().withoutDecimals().min(1).max(20).optional(),
    language: vine
      .string()
      .trim()
      .regex(/^[a-z]{2}(?:-[A-Za-z]{2})?$/)
      .optional(),
  })
)
