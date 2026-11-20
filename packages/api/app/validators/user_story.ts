import vine from '@vinejs/vine'
import { DateTime } from 'luxon'
import { sessionIdPattern } from '#lib/engine/engine_log_records'

const status = vine.enum(['backlog', 'ready', 'in-progress', 'in-review', 'done', 'discarded'])
const priority = vine.enum(['Low', 'Medium', 'High'])
const agentStatus = vine.enum(['Running', 'Paused'])
// The models that worked on the story, as the desktop reports them.
const agentModels = vine
  .array(
    vine.object({
      providerId: vine.string().trim().minLength(1).maxLength(80),
      modelId: vine.string().trim().minLength(1).maxLength(255),
      reasoningEffort: vine.string().trim().maxLength(32).nullable().optional(),
    })
  )
  .maxLength(16)
  .nullable()
  .optional()
const codeSelectionAttachment = vine.object({
  id: vine.string().trim().minLength(1).maxLength(255),
  content: vine.string().maxLength(262144),
  endLine: vine.number(),
  origin: vine.enum(['code', 'message', 'story']).optional(),
  path: vine.string().trim().minLength(1).maxLength(2048),
  startLine: vine.number(),
  storyId: vine.string().trim().minLength(1).maxLength(255).optional(),
})
const fileAttachment = vine.object({
  id: vine.string().trim().minLength(1).maxLength(36),
  content: vine.string().maxLength(13981016).optional(),
  name: vine.string().trim().minLength(1).maxLength(255),
  size: vine.number().nonNegative().withoutDecimals(),
  type: vine.string().trim().maxLength(255),
})
const nullableDateTime = vine
  .string()
  .trim()
  .nullable()
  .optional()
  .transform((value, field): DateTime | null | undefined => {
    if (value === null || value === undefined) return value
    const date = DateTime.fromISO(value)
    if (date.isValid) return date
    const sqlDate = DateTime.fromSQL(value)
    if (sqlDate.isValid) return sqlDate
    field.report('The {{ field }} field must be a datetime value', 'date', field)
    return DateTime.invalid('Invalid datetime')
  })

export const listUserStoriesValidator = vine.create({
  projectId: vine.string().trim().minLength(1),
  view: vine.enum(['summary', 'detail']).optional(),
})

export const createUserStoryValidator = vine.create({
  projectId: vine.string().trim().minLength(1),
  title: vine.string().trim().minLength(1).maxLength(255),
  summary: vine.string(),
  codeSelectionAttachments: vine.array(codeSelectionAttachment).nullable().optional(),
  fileAttachments: vine.array(fileAttachment).nullable().optional(),
  fileAttachmentUploadPending: vine.boolean().optional(),
  status: status.optional(),
  priority: priority.optional(),
  owner: vine.string().trim().minLength(1).maxLength(255).optional(),
  branch: vine.string().trim().maxLength(255).nullable().optional(),
  targetBranch: vine.string().trim().maxLength(255).nullable().optional(),
  previewUrl: vine.string().trim().maxLength(2048).nullable().optional(),
  runConfigurationId: vine.string().trim().maxLength(80).nullable().optional(),
  worktree: vine.string().trim().maxLength(2048).nullable().optional(),
  workspaceMode: vine.enum(['local-container', 'cloud-mirror', 'direct']).nullable().optional(),
  runMode: vine.enum(['local-container', 'vercel-compose', 'direct']).nullable().optional(),
  ambition: vine.enum(['quick', 'standard', 'ambitious']).nullable().optional(),
  agentStatus: agentStatus.nullable().optional(),
  agentLastError: vine.string().trim().maxLength(4096).nullable().optional(),
  agentModels,
  mergedAt: nullableDateTime,
  mergeCommit: vine.string().trim().maxLength(255).nullable().optional(),
  baseCommit: vine.string().trim().maxLength(255).nullable().optional(),
  discardedReason: vine.string().trim().maxLength(2048).nullable().optional(),
})

export const updateUserStoryValidator = vine.withMetaData<{ storyId: string }>().create({
  projectId: vine.string().trim().minLength(1).optional(),
  title: vine.string().trim().minLength(1).maxLength(255).optional(),
  summary: vine.string().optional(),
  codeSelectionAttachments: vine.array(codeSelectionAttachment).nullable().optional(),
  fileAttachments: vine.array(fileAttachment).nullable().optional(),
  fileAttachmentUploadPending: vine.boolean().optional(),
  status: status.optional(),
  priority: priority.optional(),
  owner: vine.string().trim().minLength(1).maxLength(255).optional(),
  branch: vine.string().trim().maxLength(255).nullable().optional(),
  targetBranch: vine.string().trim().maxLength(255).nullable().optional(),
  previewUrl: vine.string().trim().maxLength(2048).nullable().optional(),
  runConfigurationId: vine.string().trim().maxLength(80).nullable().optional(),
  worktree: vine.string().trim().maxLength(2048).nullable().optional(),
  workspaceMode: vine.enum(['local-container', 'cloud-mirror', 'direct']).nullable().optional(),
  runMode: vine.enum(['local-container', 'vercel-compose', 'direct']).nullable().optional(),
  ambition: vine.enum(['quick', 'standard', 'ambitious']).nullable().optional(),
  // The desktop names the story's engine session when its agent starts; the id
  // follows the engine's own rule and names one story only.
  engineSessionId: vine
    .string()
    .regex(sessionIdPattern)
    .unique({
      table: 'user_stories',
      column: 'engine_session_id',
      filter: (query, _value, field) => {
        query.whereNot('id', field.meta.storyId)
      },
    })
    .nullable()
    .optional(),
  agentStatus: agentStatus.nullable().optional(),
  agentLastError: vine.string().trim().maxLength(4096).nullable().optional(),
  agentModels,
  mergedAt: nullableDateTime,
  mergeCommit: vine.string().trim().maxLength(255).nullable().optional(),
  baseCommit: vine.string().trim().maxLength(255).nullable().optional(),
  discardedReason: vine.string().trim().maxLength(2048).nullable().optional(),
  pullRequestUrl: vine
    .string()
    .trim()
    .maxLength(2048)
    .url({ protocols: ['https'], require_protocol: true })
    .nullable()
    .optional(),
})

export const agentScreenshotUploadValidator = vine.compile(
  vine.object({
    content: vine.string().maxLength(21_000_000),
    mimeType: vine.enum(['image/png', 'image/jpeg', 'image/webp']),
    sessionId: vine.string().trim().maxLength(160).nullable().optional(),
  })
)

export const agentScreenshotQueryValidator = vine.compile(
  vine.object({
    sessionId: vine.string().trim().maxLength(160).optional(),
  })
)
