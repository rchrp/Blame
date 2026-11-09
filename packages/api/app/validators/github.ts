import vine from '@vinejs/vine'

export const linkGithubRepositoryValidator = vine.create({
  installationId: vine.string().uuid(),
  // GitHub's rules for user and organization logins.
  owner: vine
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/),
  name: vine
    .string()
    .trim()
    .regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/),
})

export const updateGithubAgentAccessValidator = vine.create({
  enabled: vine.boolean(),
})

// The project's level on the desktop: GitHub enforces it through the token's permissions.
export const issueGithubAgentTokenValidator = vine.create({
  level: vine.enum(['read', 'write'] as const),
})
