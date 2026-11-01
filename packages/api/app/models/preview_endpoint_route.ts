import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class PreviewEndpointRoute extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string
  @column()
  declare sessionId: string
  @column()
  declare endpointId: string
  @column()
  declare serviceId: string
  @column()
  declare logicalPort: number
  @column()
  declare publicHostname: string
  @column({ serializeAs: null })
  declare upstreamUrlEncrypted: string
  @column()
  declare generation: number
  @column()
  declare revoked: boolean
  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
