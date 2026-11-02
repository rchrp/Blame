import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class PreviewAccessTicket extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string
  @beforeCreate()
  static assignId(ticket: PreviewAccessTicket) {
    assignUuidV7Id(ticket)
  }
  @column()
  declare sessionId: string
  @column()
  declare ownerUserId: string
  @column()
  declare routeId: string
  @column()
  declare serviceId: string
  @column()
  declare endpointId: string
  @column({ serializeAs: null })
  declare ticketHash: string
  @column.dateTime()
  declare expiresAt: DateTime
  @column.dateTime()
  declare usedAt: DateTime | null
  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
