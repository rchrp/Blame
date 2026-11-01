import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class PreviewOperation extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string
  @beforeCreate()
  static assignId(operation: PreviewOperation) {
    assignUuidV7Id(operation)
  }
  @column()
  declare sessionId: string
  @column()
  declare operationId: string
  @column()
  declare commandType: string
  @column()
  declare status: string
  @column()
  declare resultRevision: number | null
  @column()
  declare errorCode: string | null
  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
  @column.dateTime()
  declare completedAt: DateTime | null
}
