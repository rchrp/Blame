import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type FileAttachmentStatus = 'pending' | 'ready'

export default class FileAttachment extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare userId: string

  @column()
  declare objectKey: string

  @column()
  declare name: string

  @column()
  declare mimeType: string

  @column()
  declare size: number

  @column({ columnName: 'checksum_sha256' })
  declare checksumSha256: string

  @column()
  declare status: FileAttachmentStatus

  @column.dateTime()
  declare uploadedAt: DateTime | null

  @column.dateTime()
  declare detachedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null

  declare downloadUrl?: string
}
