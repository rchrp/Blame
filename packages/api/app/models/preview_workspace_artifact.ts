import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class PreviewWorkspaceArtifact extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string
  @beforeCreate()
  static assignId(artifact: PreviewWorkspaceArtifact) {
    assignUuidV7Id(artifact)
  }
  @column()
  declare sessionId: string
  @column()
  declare kind: 'source' | 'delta'
  @column()
  declare mode: 'full' | 'delta' | null
  @column()
  declare status: 'uploading' | 'durable' | 'applied' | 'discarded' | 'invalid'
  @column({ serializeAs: null })
  declare objectKey: string
  @column({ columnName: 'sha256' })
  declare sha256: string
  @column()
  declare size: number
  @column()
  declare sourceRevision: string | null
  @column()
  declare sanitizedTreeHash: string | null
  @column()
  declare lockfileHash: string | null
  @column()
  declare workspaceHash: string | null
  @column()
  declare baseHash: string | null
  @column()
  declare finalHash: string | null
  @column()
  declare generation: number | null
  @column.dateTime()
  declare durableAt: DateTime | null
  @column.dateTime()
  declare appliedAt: DateTime | null
  @column.dateTime()
  declare discardedAt: DateTime | null
  @column.dateTime()
  declare expiresAt: DateTime
  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
