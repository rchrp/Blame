import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type PreviewProjectBaselineStatus = 'building' | 'ready' | 'failed' | 'expired' | 'deleting'

export default class PreviewProjectBaseline extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @beforeCreate()
  static assignId(baseline: PreviewProjectBaseline) {
    assignUuidV7Id(baseline)
  }

  @column()
  declare projectId: string
  @column()
  declare fingerprint: string
  @column()
  declare cacheKey: string | null
  @column()
  declare baseRevision: string
  @column()
  declare sanitizedTreeHash: string
  @column()
  declare planHash: string
  @column()
  declare lockfileHash: string
  @column()
  declare runnerVersion: string
  @column()
  declare protocolVersion: number
  @column()
  declare runnerImageDigest: string
  @column()
  declare provider: string
  @column()
  declare providerSnapshotId: string | null
  @column()
  declare ownerSandboxName: string | null
  @column()
  declare status: PreviewProjectBaselineStatus
  @column()
  declare error: string | null
  @column()
  declare snapshotBytes: number | null
  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
  @column.dateTime()
  declare lastUsedAt: DateTime | null
  @column.dateTime()
  declare expiresAt: DateTime | null
}
