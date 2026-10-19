import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { BaseModel, beforeCreate, belongsTo, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import UserStory, {
  type UserStoryAgentActivity,
  type UserStoryAgentUsage,
} from '#models/user_story'
import UserStoryComment from '#models/user_story_comment'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

export type UserStoryAgentRunKind = 'initial' | 'change-request' | 'resume'
export type UserStoryAgentRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

function prepareActivities(value: UserStoryAgentActivity[] | null) {
  return value ? JSON.stringify(value) : null
}

function consumeActivities(value: unknown) {
  if (Array.isArray(value)) return value as UserStoryAgentActivity[]
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as UserStoryAgentActivity[]) : null
  } catch {
    return null
  }
}

function prepareUsage(value: UserStoryAgentUsage | null) {
  return value ? JSON.stringify(value) : null
}

function consumeUsage(value: unknown) {
  if (!value) return null
  if (typeof value === 'object') return value as UserStoryAgentUsage
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? (parsed as UserStoryAgentUsage) : null
  } catch {
    return null
  }
}

export default class UserStoryAgentRun extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @beforeCreate()
  static assignId(run: UserStoryAgentRun) {
    assignUuidV7Id(run)
  }

  @column()
  declare userStoryId: string

  @column()
  declare commentId: string | null

  @column()
  declare kind: UserStoryAgentRunKind

  @column()
  declare clineSessionId: string | null

  @column()
  declare executionId: string | null

  // The model that answered this turn (it can change from one comment to
  // the next).
  @column()
  declare providerId: string | null

  @column()
  declare modelId: string | null

  @column()
  declare reasoningEffort: string | null

  @column()
  declare lastEventId: string | null

  @column()
  declare lastSequenceNumber: number

  @column()
  declare lastEventType: string | null

  @column.dateTime()
  declare lastEventCreatedAt: DateTime | null

  @column()
  declare checkpointRunCount: number | null

  @column()
  declare status: UserStoryAgentRunStatus

  @column({
    consume: consumeActivities,
    prepare: prepareActivities,
  })
  declare activities: UserStoryAgentActivity[] | null

  @column()
  declare finalResponse: string | null

  @column()
  declare diffEndRef: string | null

  @column({
    consume: consumeUsage,
    prepare: prepareUsage,
  })
  declare usage: UserStoryAgentUsage | null

  @column()
  declare sessionSummary: string | null

  @column.dateTime()
  declare completedAt: DateTime | null

  @belongsTo(() => UserStory)
  declare userStory: BelongsTo<typeof UserStory>

  @belongsTo(() => UserStoryComment, { foreignKey: 'commentId' })
  declare comment: BelongsTo<typeof UserStoryComment>

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
