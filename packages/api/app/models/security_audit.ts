import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type SecurityAuditSnapshot = Record<string, unknown> & {
  id: string
  projectId: string
  sequence: number
  startedAt: string
  status: string
  updatedAt: string
  version: 1
}

export default class SecurityAudit extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare projectId: string

  @column()
  declare status: string

  @column()
  declare sequence: number

  @column({
    consume: consumePayload,
    prepare: (value: SecurityAuditSnapshot) => JSON.stringify(value),
  })
  declare payload: SecurityAuditSnapshot

  @column.dateTime()
  declare startedAt: DateTime

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}

function consumePayload(value: unknown) {
  if (value && typeof value === 'object') return value as SecurityAuditSnapshot
  if (typeof value !== 'string') throw new Error('Stored security audit payload is invalid')
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Stored security audit payload is invalid')
  }
  return parsed as SecurityAuditSnapshot
}
