import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type ProjectCodePracticeAnalysisStatus = 'pending' | 'running' | 'done' | 'error'

export default class ProjectCodePracticeAnalysis extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare projectId: string

  @column()
  declare status: ProjectCodePracticeAnalysisStatus

  @column()
  declare clineSessionId: string | null

  @column()
  declare agentProviderId: string | null

  @column()
  declare agentModelId: string | null

  @column()
  declare error: string | null

  @column.dateTime()
  declare viewedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
