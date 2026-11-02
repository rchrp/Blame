import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class PreviewSession extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string
  @column()
  declare userStoryId: string
  @column()
  declare ownerUserId: string
  @column()
  declare profile: string
  @column()
  declare desired: string
  @column()
  declare state: string
  @column()
  declare revision: number
  @column()
  declare generation: number
  @column()
  declare fencingToken: number
  @column({ serializeAs: null })
  declare providerHandleEncrypted: string | null
  @column({ serializeAs: null })
  declare plan: string
  @column()
  declare planHash: string
  @column()
  declare planVersion: number
  @column()
  declare protocolVersion: number | null
  @column()
  declare runnerVersion: string | null
  @column()
  declare imageDigest: string | null
  @column()
  declare sourceRevision: string | null
  @column()
  declare workspaceHash: string | null
  @column()
  declare sourceArtifactId: string | null
  @column()
  declare baselineId: string | null
  @column({ serializeAs: null })
  declare provisionSource: string | null
  @column()
  declare lastExportedJournalRevision: string | null
  @column()
  declare lastAppliedLocalRevision: string | null
  @column()
  declare lastAcknowledgedRemoteRevision: string | null
  @column()
  declare pendingDeltaArtifactId: string | null
  @column({ serializeAs: null })
  declare endpointMapEncrypted: string | null
  @column()
  declare resourceVcpus: number
  @column()
  declare resourceMemoryGb: number
  @column()
  declare failure: string | null
  @column()
  declare selection: string | null
  @column.dateTime()
  declare lastActivityAt: DateTime
  @column.dateTime()
  declare stateChangedAt: DateTime
  @column.dateTime()
  declare leaseExpiresAt: DateTime | null
  @column.dateTime()
  declare idleDeadlineAt: DateTime | null
  @column.dateTime()
  declare stoppedAt: DateTime | null
  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
