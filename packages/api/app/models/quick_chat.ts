import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * A quick chat of a project. Its conversation is the agent engine's session
 * `engineSessionId`, kept in `engine_sessions`; this row only names it.
 */
export default class QuickChat extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @beforeCreate()
  static assignId(chat: QuickChat) {
    assignUuidV7Id(chat)
  }

  @column()
  declare projectId: string

  @column()
  declare title: string

  @column()
  declare workspace: string | null

  @column()
  declare engineSessionId: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null

  /**
   * When someone last changed the chat or pushed to its engine session, as
   * computed by the queries that join the session (`last_activity_at`).
   */
  get lastActivityAt(): DateTime {
    return databaseDateTime(this.$extras.last_activity_at) ?? this.updatedAt ?? this.createdAt
  }
}

/** A raw timestamp read the way Lucid reads one: a Date from MySQL, text from SQLite. */
function databaseDateTime(value: unknown) {
  if (value instanceof Date) return DateTime.fromJSDate(value)
  if (typeof value === 'string') {
    const parsed = DateTime.fromSQL(value)
    return parsed.isValid ? parsed : null
  }
  return null
}
