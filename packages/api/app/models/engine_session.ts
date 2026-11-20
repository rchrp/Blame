import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * A conversation of the agent engine. The engine chooses the id; the records
 * and blobs live in their own tables and are read through the service.
 */
export default class EngineSession extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare userId: string

  @column()
  declare projectId: string | null

  @column()
  declare purpose: string

  // MySQL returns BIGINT as a string for values beyond the safe range, and as
  // a number otherwise; seqs stay far below 2^53.
  @column({ columnName: 'head_seq', consume: (value: unknown) => Number(value) })
  declare headSeq: number

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
