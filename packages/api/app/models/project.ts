import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class Project extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @beforeCreate()
  static assignId(project: Project) {
    assignUuidV7Id(project)
  }

  @column()
  declare userId: string

  @column()
  declare repositoryFingerprint: string | null

  @column()
  declare name: string

  @column()
  declare lastStoryNumber: number

  /** The GitHub App installation that covers the project's repository. */
  @column()
  declare githubInstallationId: string | null

  @column()
  declare githubRepositoryOwner: string | null

  @column()
  declare githubRepositoryName: string | null

  /** GitHub access for the agent: off by default. */
  @column({ consume: (value: unknown) => Boolean(value) })
  declare githubAgentAccess: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
