import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defaultStorageDriver } from '#config/attachments'

export type WorkspaceArtifactsConfig = ReturnType<typeof workspaceArtifactsConfig>

export function workspaceArtifactsConfig() {
  const driver = workspaceStorageDriver()
  return {
    driver,
    downloadUrlTtlSeconds: env.get('BLAME_WORKSPACE_DOWNLOAD_URL_TTL_SECONDS') ?? 300,
    uploadUrlTtlSeconds: env.get('BLAME_WORKSPACE_UPLOAD_URL_TTL_SECONDS') ?? 300,
    s3: driver === 's3' ? s3Config() : null,
  }
}

export function workspaceArtifactsReady() {
  const driver = workspaceStorageDriver()
  if (driver === 'memory') return app.inTest
  return Boolean(
    secureUrl(env.get('BLAME_WORKSPACE_S3_ENDPOINT')) &&
    configuredValue('BLAME_WORKSPACE_S3_REGION') &&
    configuredValue('BLAME_WORKSPACE_S3_BUCKET') &&
    configuredSecret('BLAME_WORKSPACE_S3_ACCESS_KEY_ID') &&
    configuredSecret('BLAME_WORKSPACE_S3_SECRET_ACCESS_KEY')
  )
}

export function workspaceArtifactTransferHosts() {
  const endpoint = env.get('BLAME_WORKSPACE_S3_ENDPOINT')
  const bucket = configuredValue('BLAME_WORKSPACE_S3_BUCKET')
  const forcePathStyle = env.get('BLAME_WORKSPACE_S3_FORCE_PATH_STYLE') ?? false
  try {
    if (!endpoint) return []
    const host = new URL(endpoint).hostname
    const virtualHost =
      !forcePathStyle && bucket && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
        ? `${bucket}.${host}`
        : undefined
    return [...new Set([host, virtualHost].filter((entry): entry is string => Boolean(entry)))]
  } catch {
    return []
  }
}

function workspaceStorageDriver() {
  return env.get('BLAME_WORKSPACE_STORAGE_DRIVER') ?? defaultStorageDriver()
}

function s3Config() {
  return {
    accessKeyId: secretValue('BLAME_WORKSPACE_S3_ACCESS_KEY_ID'),
    bucket: requiredValue('BLAME_WORKSPACE_S3_BUCKET'),
    endpoint: requiredValue('BLAME_WORKSPACE_S3_ENDPOINT'),
    forcePathStyle: env.get('BLAME_WORKSPACE_S3_FORCE_PATH_STYLE') ?? false,
    region: requiredValue('BLAME_WORKSPACE_S3_REGION'),
    secretAccessKey: secretValue('BLAME_WORKSPACE_S3_SECRET_ACCESS_KEY'),
  }
}

function configuredValue(name: 'BLAME_WORKSPACE_S3_BUCKET' | 'BLAME_WORKSPACE_S3_REGION') {
  return env.get(name)?.trim()
}

function configuredSecret(
  name: 'BLAME_WORKSPACE_S3_ACCESS_KEY_ID' | 'BLAME_WORKSPACE_S3_SECRET_ACCESS_KEY'
) {
  return Boolean(env.get(name)?.release().trim())
}

function requiredValue(
  name: 'BLAME_WORKSPACE_S3_BUCKET' | 'BLAME_WORKSPACE_S3_ENDPOINT' | 'BLAME_WORKSPACE_S3_REGION'
) {
  const result = env.get(name)?.trim()
  if (!result) throw new Error(`${name} is required when BLAME_WORKSPACE_STORAGE_DRIVER=s3`)
  return result
}

function secretValue(
  name: 'BLAME_WORKSPACE_S3_ACCESS_KEY_ID' | 'BLAME_WORKSPACE_S3_SECRET_ACCESS_KEY'
) {
  const result = env.get(name)?.release().trim()
  if (!result) throw new Error(`${name} is required when BLAME_WORKSPACE_STORAGE_DRIVER=s3`)
  return result
}

function secureUrl(value: string | undefined) {
  try {
    const url = new URL(value ?? '')
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}
