import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/** 'local-cli': the provider signs in through a CLI on the user's computer, so no secret is stored. */
export type ProviderCredentialAuthMethod = 'api-key' | 'oauth' | 'local-cli'

export default class ProviderCredential extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @beforeCreate()
  static assignId(credential: ProviderCredential) {
    assignUuidV7Id(credential)
  }

  @column()
  declare userId: string

  @column()
  declare providerId: string

  @column()
  declare label: string

  @column({ serializeAs: null })
  declare encryptedApiKey: string

  @column()
  declare authMethod: ProviderCredentialAuthMethod

  @column({ serializeAs: null })
  declare encryptedOauthCredentials: string | null

  @column()
  declare accountId: string | null

  @column()
  declare baseUrl: string | null

  @column()
  declare modelIds: string | null

  @column.dateTime()
  declare expiresAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
