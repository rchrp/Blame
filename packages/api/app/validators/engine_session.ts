import vine from '@vinejs/vine'

export const pullEngineRecordsValidator = vine.create({
  after: vine.number().withoutDecimals().min(0).optional(),
  limit: vine.number().withoutDecimals().min(1).optional(),
})

export const listEngineSessionsValidator = vine.create({
  limit: vine.number().withoutDecimals().min(1).optional(),
})

export const storeEngineBlobValidator = vine.create({
  mediaType: vine
    .string()
    .trim()
    .minLength(1)
    .maxLength(255)
    .regex(/^[\x20-\x7e]+$/),
})
