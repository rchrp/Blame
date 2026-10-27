import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type ProjectCodePracticeKey =
  'coding_style' | 'unit_tests' | 'layered_architecture' | 'commit_message_convention'

export default class ProjectCodePractice extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @beforeCreate()
  static assignId(practice: ProjectCodePractice) {
    assignUuidV7Id(practice)
  }

  @column()
  declare projectId: string

  @column()
  declare practice: ProjectCodePracticeKey

  @column()
  declare detected: boolean

  @column()
  declare enabled: boolean

  @column()
  declare comment: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
