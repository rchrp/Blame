import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type FileAttachmentStatus = 'pending' | 'ready'

export default class FileAttachment extends BaseModel {
  static selfAssignPrimaryKey = true

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

  // Uploaded by a conversation the app keeps itself: no owner row ever links
  // it, so it is retained for the longer conversation grace.
  @column({ consume: (value: unknown) => Boolean(value) })
  declare conversationAttachment: boolean

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
