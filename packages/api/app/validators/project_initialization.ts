import vine from '@vinejs/vine'
import { engineProviderId } from '#validators/provider_id'

const runConfiguration = vine.object({
  id: vine
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .maxLength(80),
  name: vine.string().trim().minLength(1).maxLength(120),
  command: vine.string().trim().minLength(1).maxLength(2000),
  cwd: vine.string().trim().minLength(1).maxLength(500),
  default: vine.boolean(),
  category: vine.enum(['web', 'mobile', 'desktop', 'terminal', 'service', 'other']),
  services: vine.array(vine.string().trim().minLength(1).maxLength(80)).maxLength(20),
  previewService: vine.string().trim().minLength(1).maxLength(80).nullable().optional(),
  previewTarget: vine.string().trim().minLength(1).maxLength(80).nullable().optional(),
  scopes: vine.array(vine.string().trim().minLength(1).maxLength(500)).minLength(1).maxLength(50),
  previewUrl: vine.string().trim().minLength(1).maxLength(2048).nullable().optional(),
})

// A full Git object name: SHA-1 or SHA-256.
const commit = vine
  .string()
  .trim()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)

export const startProjectInitializationValidator = vine.create({
  providerId: engineProviderId,
  modelId: vine.string().trim().minLength(1).maxLength(255),
})

export const completeProjectInitializationValidator = vine.create({
  previewManifest: vine.any(),
  runConfigurations: vine.array(runConfiguration).maxLength(20),
  databaseMode: vine.enum(['existing', 'compose']).nullable().optional(),
  checkedCommit: commit.clone().nullable().optional(),
})

export const failProjectInitializationValidator = vine.create({
  error: vine.string().trim().minLength(1).maxLength(4096),
})

export const repairProjectInitializationValidator = vine.create({
  previewManifest: vine.any(),
  runConfigurations: vine.array(runConfiguration).maxLength(20),
  reason: vine.string().trim().minLength(1).maxLength(4096),
  databaseMode: vine.enum(['existing', 'compose']).nullable().optional(),
  checkedCommit: commit.clone().nullable().optional(),
})

export const checkProjectInitializationValidator = vine.create({
  commit,
})
