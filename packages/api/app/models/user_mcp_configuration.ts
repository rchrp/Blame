import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type CloudMcpServer = {
  command?: string
  disabled: boolean
  name: string
  timeout?: number
  transport: 'stdio' | 'streamableHttp' | 'sse'
  url?: string
}

export default class UserMcpConfiguration extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare userId: string

  @column({
    consume: (value: string | CloudMcpServer[]) =>
      typeof value === 'string' ? (JSON.parse(value) as CloudMcpServer[]) : value,
    prepare: (value: CloudMcpServer[]) => JSON.stringify(value),
  })
  declare servers: CloudMcpServer[]

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
