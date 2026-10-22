import ProviderCredentialsService from '#services/provider_credentials_service'
import {
  resolveProviderCredentialValidator,
  saveLocalProviderCredentialValidator,
  saveProviderCredentialValidator,
} from '#validators/provider_credential'
import type ProviderCredential from '#models/provider_credential'
import type { HttpContext } from '@adonisjs/core/http'

export default class ProviderCredentialsController {
  async index({ auth, serialize }: HttpContext) {
    const credentials = await new ProviderCredentialsService().list(auth.getUserOrFail().id)

    return serialize(credentials.map(providerCredentialData))
  }

  async store({ auth, request, serialize }: HttpContext) {
    return serialize(
      providerCredentialData(
        await new ProviderCredentialsService().save(
          auth.getUserOrFail().id,
          await request.validateUsing(saveProviderCredentialValidator)
        )
      )
    )
  }

  async storeLocal({ auth, request, serialize }: HttpContext) {
    return serialize(
      providerCredentialData(
        await new ProviderCredentialsService().saveLocal(
          auth.getUserOrFail().id,
          await request.validateUsing(saveLocalProviderCredentialValidator)
        )
      )
    )
  }

  async storeOAuth({ auth, request, serialize }: HttpContext) {
    const credential = await new ProviderCredentialsService().saveOAuth(
      auth.getUserOrFail().id,
      oauthCredentialInput(request.body())
    )

    return serialize(providerCredentialData(credential))
  }

  async resolve({ auth, request, serialize }: HttpContext) {
    return serialize(
      await new ProviderCredentialsService().resolve(
        auth.getUserOrFail().id,
        await request.validateUsing(resolveProviderCredentialValidator)
      )
    )
  }

  async destroy({ auth, params, response }: HttpContext) {
    await new ProviderCredentialsService().delete(auth.getUserOrFail().id, params.id)
    return response.noContent()
  }
}

function providerCredentialData(credential: ProviderCredential) {
  return {
    id: credential.id,
    userId: credential.userId,
    providerId: credential.providerId,
    label: credential.label,
    authMethod: credential.authMethod,
    accountId: credential.accountId,
    baseUrl: credential.baseUrl,
    modelIds: credentialModelIds(credential),
    expiresAt: credential.expiresAt?.toISO() ?? null,
    createdAt: credential.createdAt.toISO(),
    updatedAt: credential.updatedAt?.toISO() ?? null,
  }
}

function credentialModelIds(credential: ProviderCredential) {
  if (credential.modelIds) {
    try {
      const parsed = JSON.parse(credential.modelIds)
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
    } catch {
      return []
    }
  }
  if (credential.providerId === 'openai-compatible' && credential.label !== 'default')
    return [credential.label]
  return []
}

function oauthCredentialInput(value: unknown) {
  if (!isRecord(value) || !isRecord(value.oauthCredentials)) {
    throw new Error('Invalid OAuth credential payload')
  }

  const credentials = value.oauthCredentials
  if (
    typeof value.providerId !== 'string' ||
    typeof value.apiKey !== 'string' ||
    typeof credentials.access !== 'string' ||
    typeof credentials.refresh !== 'string' ||
    typeof credentials.expires !== 'number'
  ) {
    throw new Error('Invalid OAuth credential payload')
  }

  return {
    providerId: value.providerId,
    label: typeof value.label === 'string' ? value.label : undefined,
    apiKey: value.apiKey,
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : null,
    oauthCredentials: {
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      accountId: typeof credentials.accountId === 'string' ? credentials.accountId : undefined,
      email: typeof credentials.email === 'string' ? credentials.email : undefined,
      metadata: isRecord(credentials.metadata) ? credentials.metadata : undefined,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
