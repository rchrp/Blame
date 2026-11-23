import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * Which parts of a server live only on the computer that set it up, by name
 * (never by value): lets another device say precisely what it still needs.
 */
export type CloudMcpLocalParts = {
  args?: boolean
  cwd?: boolean
  env?: string[]
  headers?: string[]
}

/** What a person chose to sync with the server itself, encrypted at rest. */
export type CloudMcpSecrets = {
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

export type CloudMcpServer = {
  command?: string
  disabled: boolean
  localParts?: CloudMcpLocalParts
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

  /** `encryption.encrypt` of a JSON object of secrets by server name. */
  @column({ serializeAs: null })
  declare encryptedSecrets: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
