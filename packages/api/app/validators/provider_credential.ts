import vine from '@vinejs/vine'
import { engineProviderId } from '#validators/provider_id'

export const saveProviderCredentialValidator = vine.create({
  providerId: engineProviderId,
  label: vine.string().trim().minLength(1).maxLength(80).optional(),
  apiKey: vine.string().trim().minLength(1),
  baseUrl: vine.string().trim().url().nullable().optional(),
  modelIds: vine.array(vine.string().trim().minLength(1).maxLength(160)).optional(),
})

/** Providers whose sign-in lives in a CLI on the user's computer. */
export const localCliProviderIds = ['claude-code'] as const

export const saveLocalProviderCredentialValidator = vine.create({
  providerId: vine.enum(localCliProviderIds),
  label: vine.string().trim().minLength(1).maxLength(80).optional(),
  accountId: vine.string().trim().maxLength(255).nullable().optional(),
})

export const resolveProviderCredentialValidator = vine.create({
  providerId: engineProviderId,
  label: vine.string().trim().minLength(1).maxLength(80).optional(),
})
