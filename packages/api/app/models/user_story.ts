import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { orderedFileAttachments, type FileAttachmentReference } from '#lib/file_attachment'
import FileAttachment from '#models/file_attachment'
import { BaseModel, beforeCreate, column, computed, hasMany, manyToMany } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import UserStoryAgentRun from '#models/user_story_agent_run'
import UserStoryComment from '#models/user_story_comment'
import type { HasMany, ManyToMany } from '@adonisjs/lucid/types/relations'

export type UserStoryStatus =
  | 'backlog'
  | 'ready'
  | 'in-progress'
  | 'in-review'
  | 'done'
  | 'discarded'

export type UserStoryPriority = 'Low' | 'Medium' | 'High'
export type UserStoryWorkspaceMode = 'local-container' | 'cloud-mirror' | 'direct'
export type UserStoryRunMode = 'local-container' | 'vercel-compose' | 'direct'
export type UserStoryAgentStatus = 'Running' | 'Paused'
export type UserStoryAgentErrorCode =
  | 'cline_not_subscribed'
  | 'cline_org_subscription_unsupported'
  | 'cline_pass_limit'
  | 'cline_free_model_limit'
  | 'cline_model_not_found'
export type UserStoryAgentActivity = {
  id: string
  kind: 'reasoning' | 'message' | 'tool' | 'approval' | 'notice' | 'error'
  title: string
  detail: string
  actionUrl?: string
  errorCode?: UserStoryAgentErrorCode
  resetAt?: string
  status?: 'running' | 'completed' | 'failed'
  iteration?: number
  messageKind?: 'intermediate' | 'final'
  agentName?: string
  agentAvatar?: string
  toolCallId?: string
  parentToolCallId?: string
  toolName?: string
  detailArtifact?: string
  detailTruncated?: boolean
  originalDetailLength?: number
  createdAt: string
  updatedAt?: string
}

export type UserStoryCodeSelectionAttachment = {
  id: string
  content: string
  endLine: number
  path: string
  startLine: number
}

export type UserStoryFileAttachment = FileAttachmentReference

export type UserStoryAgentUsage = {
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: number
  inputTokens: number
  outputTokens: number
  totalCacheReadTokens?: number
  totalCacheWriteTokens?: number
  totalCost?: number
  totalInputTokens: number
  totalOutputTokens: number
}

export function prepareAgentActivities(value: UserStoryAgentActivity[] | null) {
  return value ? JSON.stringify(value) : null
}

export function consumeAgentActivities(value: unknown) {
  if (Array.isArray(value)) return value as UserStoryAgentActivity[]
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as UserStoryAgentActivity[]) : null
  } catch {
    return null
  }
}

export function prepareAgentActivity(value: UserStoryAgentActivity | null) {
  return value ? JSON.stringify(value) : null
}

export function consumeAgentActivity(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as UserStoryAgentActivity
  }
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as UserStoryAgentActivity)
      : null
  } catch {
    return null
  }
}

export function prepareAgentUsage(value: UserStoryAgentUsage | null) {
  return value ? JSON.stringify(value) : null
}

export function consumeAgentUsage(value: unknown) {
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

export function prepareCodeSelectionAttachments(value: UserStoryCodeSelectionAttachment[] | null) {
  return value ? JSON.stringify(value) : null
}

export function consumeCodeSelectionAttachments(value: unknown) {
  if (Array.isArray(value)) return value as UserStoryCodeSelectionAttachment[]
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as UserStoryCodeSelectionAttachment[]) : null
  } catch {
    return null
  }
}

export function prepareFileAttachments(value: UserStoryFileAttachment[] | null) {
  return value ? JSON.stringify(value) : null
}

export function consumeFileAttachments(value: unknown) {
  if (Array.isArray(value)) return value as UserStoryFileAttachment[]
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as UserStoryFileAttachment[]) : null
  } catch {
    return null
  }
}

export default class UserStory extends BaseModel {
  static selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare id: string

  @beforeCreate()
  static assignId(story: UserStory) {
    assignUuidV7Id(story)
  }

  @column()
  declare projectId: string

  @column()
  declare storyNumber: number

  @column()
  declare title: string

  @column()
  declare summary: string

  @column({
    consume: consumeCodeSelectionAttachments,
    prepare: prepareCodeSelectionAttachments,
  })
  declare codeSelectionAttachments: UserStoryCodeSelectionAttachment[] | null

  @column({
    columnName: 'file_attachments',
    consume: consumeFileAttachments,
    prepare: prepareFileAttachments,
    serializeAs: null,
  })
  declare legacyFileAttachments: UserStoryFileAttachment[] | null

  @manyToMany(() => FileAttachment, {
    pivotColumns: ['position'],
    pivotForeignKey: 'user_story_id',
    pivotRelatedForeignKey: 'file_attachment_id',
    pivotTable: 'user_story_file_attachments',
    serializeAs: null,
  })
  declare storedFileAttachments: ManyToMany<typeof FileAttachment>

  @computed()
  get fileAttachments(): UserStoryFileAttachment[] | null {
    const stored = this.$preloaded.storedFileAttachments as FileAttachment[] | undefined
    return stored?.length ? orderedFileAttachments(stored) : this.legacyFileAttachments
  }

  @column()
  declare fileAttachmentUploadPending: boolean

  @column()
  declare status: UserStoryStatus

  @column()
  declare priority: UserStoryPriority

  @column()
  declare owner: string

  @column()
  declare branch: string | null

  @column()
  declare previewUrl: string | null

  @column()
  declare runConfigurationId: string | null

  @column()
  declare worktree: string | null

  @column()
  declare workspaceMode: UserStoryWorkspaceMode | null

  @column()
  declare runMode: UserStoryRunMode | null

  @column()
  declare agentStatus: UserStoryAgentStatus | null

  @column()
  declare clineSessionId: string | null

  @column()
  declare agentProviderId: string | null

  @column()
  declare agentModelId: string | null

  @column()
  declare agentLastEvent: string | null

  @column()
  declare agentLastError: string | null

  @column({
    consume: consumeAgentActivities,
    prepare: prepareAgentActivities,
  })
  declare agentActivities: UserStoryAgentActivity[] | null

  @column()
  declare agentFinalResponse: string | null

  @column({
    consume: consumeAgentUsage,
    prepare: prepareAgentUsage,
  })
  declare agentUsage: UserStoryAgentUsage | null

  @column()
  declare agentSessionSummary: string | null

  @column()
  declare activeAgentRunId: string | null

  @column.dateTime()
  declare mergedAt: DateTime | null

  @column()
  declare mergeCommit: string | null

  @column()
  declare baseCommit: string | null

  @column()
  declare discardedReason: string | null

  @hasMany(() => UserStoryComment)
  declare comments: HasMany<typeof UserStoryComment>

  @hasMany(() => UserStoryAgentRun)
  declare agentRuns: HasMany<typeof UserStoryAgentRun>

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
