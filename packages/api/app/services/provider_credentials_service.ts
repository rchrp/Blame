import ProviderCredential, { type ProviderCredentialAuthMethod } from '#models/provider_credential'
import encryption from '@adonisjs/core/services/encryption'
import type { Infer } from '@vinejs/vine/types'
import type {
  resolveProviderCredentialValidator,
  saveLocalProviderCredentialValidator,
  saveProviderCredentialValidator,
} from '#validators/provider_credential'
import { DateTime } from 'luxon'

type SaveProviderCredentialInput = Infer<typeof saveProviderCredentialValidator>
type SaveLocalProviderCredentialInput = Infer<typeof saveLocalProviderCredentialValidator>
type ResolveProviderCredentialInput = Infer<typeof resolveProviderCredentialValidator>
type OAuthCredentialsInput = {
  access: string
  refresh: string
  expires: number
  accountId?: string
  email?: string
  metadata?: Record<string, unknown>
}
type SaveOAuthCredentialInput = {
  providerId: string
  label?: string
  apiKey: string
  oauthCredentials: OAuthCredentialsInput
  baseUrl?: string | null
}
type UpsertProviderCredentialInput = {
  providerId: string
  label?: string
  encryptedApiKey: string
  authMethod: ProviderCredentialAuthMethod
  encryptedOauthCredentials: string | null
  accountId: string | null
  baseUrl?: string | null
  modelIds?: string[]
  expiresAt: DateTime | null
}

const defaultLabel = 'default'

export default class ProviderCredentialsService {
  async list(userId: string) {
    return ProviderCredential.query().where('userId', userId).orderBy('providerId', 'asc')
  }

  async save(userId: string, input: SaveProviderCredentialInput) {
    return this.upsert(userId, {
      providerId: input.providerId,
      label: input.label,
      encryptedApiKey: await encryption.encrypt(input.apiKey),
      authMethod: 'api-key',
      encryptedOauthCredentials: null,
      accountId: null,
      baseUrl: input.baseUrl,
      modelIds: input.modelIds,
      expiresAt: null,
    })
  }

  /** The CLI keeps the sign-in on the user's computer: only the account is recorded. */
  async saveLocal(userId: string, input: SaveLocalProviderCredentialInput) {
    return this.upsert(userId, {
      providerId: input.providerId,
      label: input.label,
      encryptedApiKey: await encryption.encrypt(''),
      authMethod: 'local-cli',
      encryptedOauthCredentials: null,
      accountId: input.accountId ?? null,
      baseUrl: null,
      modelIds: undefined,
      expiresAt: null,
    })
  }

  async saveOAuth(userId: string, input: SaveOAuthCredentialInput) {
    return this.upsert(userId, {
      providerId: input.providerId,
      label: input.label,
      encryptedApiKey: await encryption.encrypt(input.apiKey),
      authMethod: 'oauth',
      encryptedOauthCredentials: await encryption.encrypt(JSON.stringify(input.oauthCredentials)),
      accountId: input.oauthCredentials.accountId ?? input.oauthCredentials.email ?? null,
      baseUrl: input.baseUrl,
      modelIds: undefined,
      expiresAt: DateTime.fromMillis(input.oauthCredentials.expires),
    })
  }

  async resolve(userId: string, input: ResolveProviderCredentialInput) {
    const credential = await ProviderCredential.query()
      .where('userId', userId)
      .where('providerId', input.providerId)
      .where('label', input.label ?? defaultLabel)
      .firstOrFail()
    return {
      id: credential.id,
      providerId: credential.providerId,
      label: credential.label,
      authMethod: credential.authMethod,
      apiKey: await encryption.decrypt(credential.encryptedApiKey),
      oauthCredentials: await this.decryptOAuthCredentials(credential),
      baseUrl: credential.baseUrl,
      modelIds: credentialModelIds(credential),
    }
  }

  async delete(userId: string, id: string) {
    const credential = await ProviderCredential.query()
      .where('userId', userId)
      .where('id', id)
      .firstOrFail()
    await credential.delete()
  }

  private async upsert(userId: string, input: UpsertProviderCredentialInput) {
    const label = input.label ?? defaultLabel
    const existing = await ProviderCredential.query()
      .where('userId', userId)
      .where('providerId', input.providerId)
      .where('label', label)
      .first()

    if (!existing) {
      return ProviderCredential.create({
        userId,
        providerId: input.providerId,
        label,
        encryptedApiKey: input.encryptedApiKey,
        authMethod: input.authMethod,
        encryptedOauthCredentials: input.encryptedOauthCredentials,
        accountId: input.accountId,
        baseUrl: input.baseUrl ?? null,
        modelIds: serializeModelIds(input.modelIds),
        expiresAt: input.expiresAt,
      })
    }

    existing.merge({
      encryptedApiKey: input.encryptedApiKey,
      authMethod: input.authMethod,
      encryptedOauthCredentials: input.encryptedOauthCredentials,
      accountId: input.accountId,
      baseUrl: input.baseUrl ?? null,
      modelIds: serializeModelIds(input.modelIds),
      expiresAt: input.expiresAt,
    })
    await existing.save()
    return existing
  }

  private async decryptOAuthCredentials(credential: ProviderCredential) {
    if (!credential.encryptedOauthCredentials) {
      return null
    }

    const decryptedCredentials = await encryption.decrypt(credential.encryptedOauthCredentials)
    if (typeof decryptedCredentials !== 'string') {
      return null
    }

    return JSON.parse(decryptedCredentials) as OAuthCredentialsInput
  }
}

function serializeModelIds(modelIds: string[] | undefined) {
  const normalized = uniqueModelIds(modelIds)
  return normalized.length ? JSON.stringify(normalized) : null
}

export function credentialModelIds(credential: ProviderCredential) {
  const parsed = parseModelIds(credential.modelIds)
  if (parsed.length) return parsed
  if (credential.providerId === 'openai-compatible' && credential.label !== defaultLabel) {
    return [credential.label]
  }
  return []
}

function parseModelIds(value: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? uniqueModelIds(parsed) : []
  } catch {
    return []
  }
}

function uniqueModelIds(values: unknown[] | undefined) {
  return Array.from(
    new Set(
      (values ?? [])
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )
}
