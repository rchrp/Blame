import vine from '@vinejs/vine'

export const uploadFileAttachmentContentValidator = vine.compile(
  vine.object({ content: vine.string().maxLength(14_000_000).nullable() })
)

export const createFileAttachmentUploadValidator = vine.compile(
  vine.object({
    checksumSha256: vine
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/),
    id: vine.string().trim().minLength(1).maxLength(36),
    name: vine.string().trim().minLength(1).maxLength(255),
    size: vine.number().nonNegative().withoutDecimals(),
    type: vine.string().trim().maxLength(255),
  })
)
