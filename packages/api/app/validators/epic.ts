import vine from '@vinejs/vine'
import { sessionIdPattern } from '#lib/engine/engine_log_records'
import { engineProviderId } from '#validators/provider_id'
import { nullableDateTime } from '#validators/user_story'

const minAtMostMax = vine.createRule((value, _options, field) => {
  const range = value as { min: number; max: number }
  if (range.min > range.max) {
    field.report('The {{ field }} field must have a min that is at most its max', 'range', field)
  }
})

const status = vine.enum(['active', 'paused', 'completed', 'discarded'])

// The keys of the settings the orchestrator reads are checked when present;
// any other key is kept as sent.
const settings = vine
  .object({
    modelRange: vine
      .object({
        min: vine.number().min(0).max(1),
        max: vine.number().min(0).max(1),
      })
      .use(minAtMostMax())
      .optional(),
    providers: vine.array(engineProviderId.clone()).maxLength(16).optional(),
    budgetMicroUsd: vine.number().withoutDecimals().min(0).optional(),
    askBeforeLaunch: vine.boolean().optional(),
  })
  .allowUnknownProperties()

export const listEpicsValidator = vine.create({
  projectId: vine.string().trim().minLength(1),
})

export const createEpicValidator = vine.create({
  projectId: vine.string().trim().minLength(1),
  title: vine.string().trim().minLength(1).maxLength(255),
  goal: vine.string().maxLength(65535).nullable().optional(),
  status: status.optional(),
  branch: vine.string().trim().minLength(1).maxLength(255).nullable().optional(),
  targetBranch: vine.string().trim().minLength(1).maxLength(255).nullable().optional(),
  // The orchestrator's engine session names one epic only.
  engineSessionId: vine
    .string()
    .regex(sessionIdPattern)
    .unique({ table: 'epics', column: 'engine_session_id' })
    .nullable()
    .optional(),
  settings: settings.optional(),
  mergedAt: nullableDateTime,
  mergeCommit: vine.string().trim().maxLength(255).nullable().optional(),
})

export const updateEpicValidator = vine.withMetaData<{ epicId: string }>().create({
  title: vine.string().trim().minLength(1).maxLength(255).optional(),
  goal: vine.string().maxLength(65535).nullable().optional(),
  status: status.optional(),
  branch: vine.string().trim().minLength(1).maxLength(255).nullable().optional(),
  targetBranch: vine.string().trim().minLength(1).maxLength(255).nullable().optional(),
  engineSessionId: vine
    .string()
    .regex(sessionIdPattern)
    .unique({
      table: 'epics',
      column: 'engine_session_id',
      filter: (query, _value, field) => {
        query.whereNot('id', field.meta.epicId)
      },
    })
    .nullable()
    .optional(),
  // The whole object is replaced.
  settings: settings.optional(),
  mergedAt: nullableDateTime,
  mergeCommit: vine.string().trim().maxLength(255).nullable().optional(),
})
