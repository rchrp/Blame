import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/** An installation of the Blame GitHub App that GitHub confirmed the user can access. */
export default class GithubAppInstallation extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @beforeCreate()
  static assignId(installation: GithubAppInstallation) {
    assignUuidV7Id(installation)
  }

  @column()
  declare userId: string

  /** GitHub's id of the installation. */
  @column()
  declare installationId: string

  /** The user or organization the app is installed on. */
  @column()
  declare accountLogin: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
