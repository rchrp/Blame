import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type AiReasoningEffort =
  'none' | 'enabled' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type AgentResponseStyle = 'concise' | 'balanced' | 'detailed'
export type AgentExperience = 'new' | 'comfortable' | 'experienced'
export type AgentAutonomy = 'ask' | 'balanced' | 'decide'
export type AgentAmbition = 'quick' | 'standard' | 'ambitious'

export default class UserAiPreference extends BaseModel {
  static selfAssignPrimaryKey = true

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

  @column()
  declare responseStyle: AgentResponseStyle

  @column()
  declare experience: AgentExperience

  @column()
  declare autonomy: AgentAutonomy

  @column()
  declare ambition: AgentAmbition

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
