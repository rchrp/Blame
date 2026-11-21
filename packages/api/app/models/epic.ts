import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export type EpicStatus = 'active' | 'paused' | 'completed' | 'discarded'

// The keys the orchestrator reads; the object may hold others.
export type EpicSettings = {
  // The slice of the models' ranking the epic may pick from, 0 (cheapest) to 1.
  modelRange?: { min: number; max: number }
  providers?: string[]
  budgetMicroUsd?: number
  askBeforeLaunch?: boolean
  [key: string]: unknown
}

function prepareSettings(value: EpicSettings | null) {
  return JSON.stringify(value ?? {})
}

function consumeSettings(value: unknown): EpicSettings {
  const parsed = typeof value === 'string' ? safeParse(value) : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as EpicSettings)
    : {}
}

function safeParse(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

/**
 * An epic of a project: a goal the orchestrator pursues through stories, an
 * integration branch they merge into and a budget. Its conversation is the
 * agent engine's session `engineSessionId`, kept in `engine_sessions`; this
 * row only names it.
 */
export default class Epic extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @beforeCreate()
  static assignId(epic: Epic) {
    assignUuidV7Id(epic)
    epic.settings ??= {}
  }

  @column()
  declare projectId: string

  @column()
  declare title: string

  @column()
  declare goal: string | null

  @column()
  declare status: EpicStatus

  // The epic's integration branch.
  @column()
  declare branch: string | null

  // Where the epic merges at the end.
  @column()
  declare targetBranch: string | null

  @column()
  declare engineSessionId: string | null

  @column({ consume: consumeSettings, prepare: prepareSettings })
  declare settings: EpicSettings

  @column.dateTime()
  declare mergedAt: DateTime | null

  @column()
  declare mergeCommit: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
