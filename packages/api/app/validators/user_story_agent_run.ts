import vine from '@vinejs/vine'
import { agentActivity, agentUsage, nullableDateTime } from '#validators/user_story'

const kind = vine.enum(['initial', 'change-request', 'resume'])
const status = vine.enum(['pending', 'running', 'completed', 'failed', 'cancelled'])
const terminalStatus = vine.enum(['completed', 'failed', 'cancelled'])
const finalizationOutcome = vine.enum(['review', 'paused'])
export const agentPersistenceEvent = vine.object({
  sessionId: vine.string().trim().minLength(1).maxLength(255),
  runId: vine.string().trim().uuid(),
  executionId: vine.string().trim().uuid(),
  eventId: vine.string().trim().minLength(1).maxLength(255),
  sequenceNumber: vine.number().withoutDecimals().positive(),
  eventType: vine.string().trim().minLength(1).maxLength(64),
  createdAt: vine.string().trim().minLength(1).maxLength(255),
})
const diffEndRef = vine
  .string()
  .trim()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)
  .nullable()
  .optional()

export const createUserStoryAgentRunValidator = vine.create({
  commentId: vine.string().trim().uuid().nullable().optional(),
  kind,
  clineSessionId: vine.string().trim().maxLength(255).nullable().optional(),
  executionId: vine.string().trim().uuid().nullable().optional(),
  checkpointRunCount: vine.number().withoutDecimals().positive().nullable().optional(),
  status: status.optional(),
  providerId: vine.string().trim().maxLength(80).nullable().optional(),
  modelId: vine.string().trim().maxLength(255).nullable().optional(),
  reasoningEffort: vine.string().trim().maxLength(32).nullable().optional(),
})

export const updateUserStoryAgentRunValidator = vine.create({
  clineSessionId: vine.string().trim().maxLength(255).nullable().optional(),
  checkpointRunCount: vine.number().withoutDecimals().positive().nullable().optional(),
  diffEndRef,
  status: status.optional(),
  activities: vine.array(agentActivity).nullable().optional(),
  agentActivity: agentActivity.nullable().optional(),
  agentActivityUpdates: vine.array(agentActivity).maxLength(16).optional(),
  finalResponse: vine.string().nullable().optional(),
  usage: agentUsage.nullable().optional(),
  sessionSummary: vine.string().nullable().optional(),
  completedAt: nullableDateTime,
  persistenceEvent: agentPersistenceEvent.optional(),
})

export const finalizeUserStoryAgentRunValidator = vine.create({
  activities: vine.array(agentActivity),
  agentLastError: vine.string().trim().maxLength(4096).nullable().optional(),
  agentLastEvent: vine.string().trim().maxLength(4096).nullable().optional(),
  completedAt: nullableDateTime,
  diffEndRef,
  finalResponse: vine.string().nullable().optional(),
  outcome: finalizationOutcome,
  sessionSummary: vine.string().nullable().optional(),
  status: terminalStatus,
  usage: agentUsage.nullable().optional(),
  persistenceEvent: agentPersistenceEvent,
})
