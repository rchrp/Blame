import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import { parsePreviewManifest, type PreviewManifest } from '@blame/preview-contract'

export type ProjectInitializationStatus = 'pending' | 'running' | 'done' | 'error'
export type ProjectInitializationDatabaseMode = 'existing' | 'compose'

type ProjectRunConfiguration = {
  id: string
  name: string
  command: string
  cwd: string
  default: boolean
  category: 'web' | 'mobile' | 'desktop' | 'terminal' | 'service' | 'other'
  services: string[]
  previewService?: string | null
  previewTarget?: string | null
  scopes: string[]
  previewUrl?: string | null
}

export function prepareRunConfigurations(value: ProjectRunConfiguration[] | null) {
  return value ? JSON.stringify(value) : null
}

export function consumeRunConfigurations(value: unknown) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value as ProjectRunConfiguration[]
  if (typeof value !== 'string') throw new Error('Stored run configurations must be JSON')
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('Stored run configurations must be an array')
  return parsed as ProjectRunConfiguration[]
}

export function preparePreviewManifest(value: PreviewManifest | null) {
  return value ? JSON.stringify(value) : null
}

export function consumePreviewManifest(value: unknown) {
  if (value === null || value === undefined) return null
  return parsePreviewManifest(typeof value === 'string' ? JSON.parse(value) : value)
}

export default class ProjectInitialization extends BaseModel {
  @column({ isPrimary: true })
  declare projectId: string

  @column()
  declare status: ProjectInitializationStatus

  @column()
  declare step: string

  @column()
  declare clineSessionId: string | null

  @column()
  declare agentProviderId: string | null

  @column()
  declare agentModelId: string | null

  @column({
    consume: consumePreviewManifest,
    prepare: preparePreviewManifest,
  })
  declare previewManifest: PreviewManifest | null

  @column({
    consume: consumeRunConfigurations,
    prepare: prepareRunConfigurations,
  })
  declare runConfigurations: ProjectRunConfiguration[] | null

  @column()
  declare databaseMode: ProjectInitializationDatabaseMode | null

  @column()
  declare error: string | null

  @column()
  declare repairReason: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
