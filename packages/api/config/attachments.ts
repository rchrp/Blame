import { join } from 'node:path'
import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { deployment } from '#lib/deployment'

export type AttachmentsConfig = ReturnType<typeof attachmentsConfig>

export function attachmentsConfig() {
  const driver = env.get('ATTACHMENTS_STORAGE_DRIVER') ?? defaultStorageDriver()
  return {
    driver,
    downloadUrlTtlSeconds: env.get('ATTACHMENTS_DOWNLOAD_URL_TTL_SECONDS') ?? 900,
    // Grace for the files a kept conversation (plan mode) uploads, which no
    // owner row links while the thread is still shown.
    conversationOrphanGraceHours: env.get('ATTACHMENTS_CONVERSATION_ORPHAN_GRACE_HOURS') ?? 720,
    maxBytes: env.get('ATTACHMENTS_MAX_BYTES') ?? 10_485_760,
    orphanGraceHours: env.get('ATTACHMENTS_ORPHAN_GRACE_HOURS') ?? 24,
    uploadUrlTtlSeconds: env.get('ATTACHMENTS_UPLOAD_URL_TTL_SECONDS') ?? 900,
    s3: driver === 's3' ? s3Config() : null,
  }
}

function s3Config() {
  return {
    accessKeyId: secretValue('ATTACHMENTS_S3_ACCESS_KEY_ID'),
    bucket: stringValue('ATTACHMENTS_S3_BUCKET'),
    endpoint: stringValue('ATTACHMENTS_S3_ENDPOINT'),
    forcePathStyle: env.get('ATTACHMENTS_S3_FORCE_PATH_STYLE') ?? false,
    region: stringValue('ATTACHMENTS_S3_REGION'),
    secretAccessKey: secretValue('ATTACHMENTS_S3_SECRET_ACCESS_KEY'),
  }
}

function stringValue(
  name: 'ATTACHMENTS_S3_BUCKET' | 'ATTACHMENTS_S3_ENDPOINT' | 'ATTACHMENTS_S3_REGION'
) {
  const value = env.get(name)?.trim()
  if (!value) throw new Error(`${name} is required when ATTACHMENTS_STORAGE_DRIVER=s3`)
  return value
}

function secretValue(name: 'ATTACHMENTS_S3_ACCESS_KEY_ID' | 'ATTACHMENTS_S3_SECRET_ACCESS_KEY') {
  const value = env.get(name)?.release().trim()
  if (!value) throw new Error(`${name} is required when ATTACHMENTS_STORAGE_DRIVER=s3`)
  return value
}

/** Hosted storage for the hosted API, files on disk for the local one. */
export function defaultStorageDriver() {
  if (!deployment.hostedServices) return 'filesystem' as const
  return app.inTest ? ('memory' as const) : ('s3' as const)
}

export function localStorageDirectory(area: string) {
  const directory = env.get('BLAME_LOCAL_STORAGE_DIRECTORY')?.trim()
  if (!directory)
    throw new Error('BLAME_LOCAL_STORAGE_DIRECTORY is required by the filesystem driver')
  return join(directory, area)
}
