import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { orderedFileAttachments, type FileAttachmentReference } from '#lib/file_attachment'
import FileAttachment from '#models/file_attachment'
import { BaseModel, beforeCreate, column, computed, manyToMany } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import type { ManyToMany } from '@adonisjs/lucid/types/relations'

export type UserStoryStatus =
  'backlog' | 'ready' | 'in-progress' | 'in-review' | 'done' | 'discarded'

export type UserStoryPriority = 'Low' | 'Medium' | 'High'
export type UserStoryWorkspaceMode = 'local-container' | 'cloud-mirror' | 'direct'
export type UserStoryRunMode = 'local-container' | 'vercel-compose' | 'direct'
// How far the agent goes on this story; null follows the account's ambition.
export type UserStoryAmbition = 'quick' | 'standard' | 'ambitious'
export type UserStoryAgentStatus = 'Running' | 'Paused'
// A model that worked on the story, shown on its board card.
export type UserStoryAgentModel = {
  providerId: string
  modelId: string
  reasoningEffort?: string | null
  turns?: number
}

export type UserStoryCodeSelectionAttachment = {
  id: string
  content: string
  endLine: number
  path: string
  startLine: number
}

export type UserStoryFileAttachment = FileAttachmentReference

// How the orchestrator weighs a story when it picks a model.
export type UserStoryModelIntent = 'cheaper' | 'balanced' | 'smarter'
// The model the story's first run must use.
export type UserStoryRequestedModel = {
  providerId: string
  modelId: string
  credentialLabel?: string
  reasoningEffort?: string
}

function prepareStartsAfter(value: string[] | null | undefined) {
  return JSON.stringify(value ?? [])
}

function consumeStartsAfter(value: unknown): string[] {
  const parsed = typeof value === 'string' ? safeParse(value) : value
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
}

function prepareRequestedModel(value: UserStoryRequestedModel | null | undefined) {
  return value ? JSON.stringify(value) : null
}

function consumeRequestedModel(value: unknown) {
  const parsed = typeof value === 'string' ? safeParse(value) : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as UserStoryRequestedModel)
    : null
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function prepareAgentModels(value: UserStoryAgentModel[] | null) {
  return value ? JSON.stringify(value) : null
}

function consumeAgentModels(value: unknown) {
  if (Array.isArray(value)) return value as UserStoryAgentModel[]
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as UserStoryAgentModel[]) : null
  } catch {
    return null
  }
}

function prepareCodeSelectionAttachments(value: UserStoryCodeSelectionAttachment[] | null) {
  return value ? JSON.stringify(value) : null
}

function consumeCodeSelectionAttachments(value: unknown) {
  if (Array.isArray(value)) return value as UserStoryCodeSelectionAttachment[]
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as UserStoryCodeSelectionAttachment[]) : null
  } catch {
    return null
  }
}

function prepareFileAttachments(value: UserStoryFileAttachment[] | null) {
  return value ? JSON.stringify(value) : null
}

function consumeFileAttachments(value: unknown) {
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

  // The branch the story starts from and merges into.
  @column()
  declare targetBranch: string | null

  // The GitHub pull request opened from the story, if any.
  @column()
  declare pullRequestUrl: string | null

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
  declare ambition: UserStoryAmbition | null

  // Ids of the stories this one waits for. A story that others list can be
  // deleted: its id stays in their lists, and clients show them as blocked.
  @column({ consume: consumeStartsAfter, prepare: prepareStartsAfter })
  declare startsAfter: string[]

  @column()
  declare modelIntent: UserStoryModelIntent | null

  @column({ consume: consumeRequestedModel, prepare: prepareRequestedModel })
  declare requestedModel: UserStoryRequestedModel | null

  // The epic the orchestrator made the story for, of the same project.
  @column()
  declare epicId: string | null

  // The agent engine's session holding the story's conversation, kept in
  // `engine_sessions`; the desktop names it when the story's agent starts.
  @column()
  declare engineSessionId: string | null

  @column()
  declare agentStatus: UserStoryAgentStatus | null

  @column()
  declare agentLastError: string | null

  @column({ consume: consumeAgentModels, prepare: prepareAgentModels })
  declare agentModels: UserStoryAgentModel[] | null

  @column.dateTime()
  declare mergedAt: DateTime | null

  @column()
  declare mergeCommit: string | null

  @column()
  declare baseCommit: string | null

  @column()
  declare discardedReason: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
