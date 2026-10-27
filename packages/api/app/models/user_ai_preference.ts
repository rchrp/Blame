import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type AiReasoningEffort =
  'none' | 'enabled' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export default class UserAiPreference extends BaseModel {
  @column({ isPrimary: true })
  declare userId: string

  @column()
  declare alternativeProviderId: string

  @column()
  declare alternativeModelId: string

  @column()
  declare alternativeCredentialLabel: string | null

  @column()
  declare alternativeReasoningEffort: AiReasoningEffort | null

  @column()
  declare agentProviderId: string

  @column()
  declare agentModelId: string

  @column()
  declare agentCredentialLabel: string | null

  @column()
  declare agentReasoningEffort: AiReasoningEffort | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
