import vine from '@vinejs/vine'

const partName = vine.string().trim().minLength(1).maxLength(200)

export const saveUserMcpConfigurationValidator = vine.create({
  servers: vine
    .array(
      vine.object({
        command: vine.string().trim().minLength(1).maxLength(500).optional(),
        disabled: vine.boolean(),
        // Names of what stays on the device that set the server up.
        localParts: vine
          .object({
            args: vine.boolean().optional(),
            cwd: vine.boolean().optional(),
            env: vine.array(partName).maxLength(50).optional(),
            headers: vine.array(partName).maxLength(50).optional(),
          })
          .optional(),
        name: vine.string().trim().minLength(1).maxLength(80),
        // The person's opt-in to keep this server's secrets in the account.
        // false removes what was stored; absent keeps it (older apps).
        secretsSynced: vine.boolean().optional(),
        secrets: vine
          .object({
            args: vine.array(vine.string().maxLength(4000)).maxLength(100).optional(),
            cwd: vine.string().maxLength(1000).optional(),
            env: vine.record(vine.string().maxLength(8000)).optional(),
            headers: vine.record(vine.string().maxLength(8000)).optional(),
          })
          .optional(),
        timeout: vine.number().min(1).max(3600).withoutDecimals().optional(),
        transport: vine.enum(['stdio', 'streamableHttp', 'sse']),
        url: vine
          .string()
          .trim()
          .url({ protocols: ['http', 'https'] })
          .maxLength(2048)
          .optional(),
      })
    )
    .maxLength(100),
})
