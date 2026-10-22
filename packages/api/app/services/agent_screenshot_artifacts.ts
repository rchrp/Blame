import type { UserStoryAgentActivity } from '#models/user_story'
import { workspaceArtifactObjectStorage } from '#services/workspace_artifacts/workspace_artifact_object_storage'
import { createHash } from 'node:crypto'

// Screenshots taken by an agent, referenced from its activities by id (the
// SHA-256 of the image). They are stored encrypted for the story or chat
// that owns the activities, and deleted with them.

export const maximumScreenshotBytes = 15 * 1024 * 1024
const idPattern = /^[0-9a-f]{64}$/u
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])

export type ScreenshotUpload = {
  content: string
  mimeType: string
  sessionId?: string | null
}

export class ScreenshotArtifactError extends Error {}

export async function putScreenshotArtifact(ownerId: string, id: string, upload: ScreenshotUpload) {
  assertScreenshotId(id)
  if (!imageTypes.has(upload.mimeType)) throw new ScreenshotArtifactError('Unsupported image type.')
  const content = Buffer.from(upload.content, 'base64')
  if (!content.byteLength || content.byteLength > maximumScreenshotBytes)
    throw new ScreenshotArtifactError('The screenshot size is invalid.')
  const checksum = createHash('sha256').update(content).digest('hex')
  if (checksum !== id) throw new ScreenshotArtifactError('The screenshot does not match its id.')
  const key = screenshotObjectKey(ownerId, upload.sessionId, id)
  const storage = workspaceArtifactObjectStorage()
  const existing = await storage.head(key).catch(() => undefined)
  if (existing?.checksumSha256 === id && existing.encryptionScope === ownerId) return { id }
  await storage.put(key, content, {
    checksumSha256: checksum,
    contentType: upload.mimeType,
    encryptionScope: ownerId,
    size: content.byteLength,
  })
  return { id }
}

export async function screenshotArtifact(
  ownerId: string,
  id: string,
  sessionId: string | null | undefined
) {
  assertScreenshotId(id)
  const key = screenshotObjectKey(ownerId, sessionId, id)
  const storage = workspaceArtifactObjectStorage()
  const metadata = await storage.head(key)
  if (metadata.encryptionScope !== ownerId) throw new ScreenshotArtifactError('Not found.')
  const content = Buffer.from(await storage.content(key))
  if (createHash('sha256').update(content).digest('hex') !== id)
    throw new ScreenshotArtifactError('Not found.')
  return { content: content.toString('base64'), id, mimeType: metadata.contentType }
}

export function screenshotKeysFromActivities(
  ownerId: string,
  activityGroups: Array<UserStoryAgentActivity[] | null | undefined>
) {
  const keys = new Set<string>()
  for (const activity of activityGroups.flatMap((group) => group ?? [])) {
    for (const ref of screenshotRefs(activity.detail))
      keys.add(screenshotObjectKey(ownerId, ref.sessionId, ref.id))
  }
  return [...keys]
}

export function screenshotObjectKey(
  ownerId: string,
  sessionId: string | null | undefined,
  id: string
) {
  assertScreenshotId(id)
  return [
    'agent-screenshots',
    safeFilename(ownerId),
    safeFilename(sessionId || 'unknown-session'),
    id,
  ].join('/')
}

function screenshotRefs(detail: string) {
  if (!detail.includes('screenshot_ref')) return []
  const refs: Array<{ id: string; sessionId?: string }> = []
  try {
    collect(JSON.parse(detail), refs)
  } catch {}
  return refs
}

function collect(value: unknown, refs: Array<{ id: string; sessionId?: string }>) {
  if (Array.isArray(value)) value.forEach((item) => collect(item, refs))
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (
      record.type === 'screenshot_ref' &&
      typeof record.id === 'string' &&
      idPattern.test(record.id)
    ) {
      refs.push({
        id: record.id,
        ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
      })
    } else Object.values(record).forEach((item) => collect(item, refs))
  }
}

function assertScreenshotId(id: string) {
  if (!idPattern.test(id)) throw new ScreenshotArtifactError('Invalid screenshot id.')
}

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 160)
}
