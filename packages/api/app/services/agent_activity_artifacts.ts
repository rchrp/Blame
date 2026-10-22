import type { UserStoryAgentActivity } from '#models/user_story'
import { workspaceArtifactObjectStorage } from '#services/workspace_artifacts/workspace_artifact_object_storage'
import { screenshotKeysFromActivities } from '#services/agent_screenshot_artifacts'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

const maxPersistedDetailLength = 4096
const objectReferencePrefix = 'agent-activity://'

export async function activityWithArtifact(
  ownerId: string,
  sessionId: string | null | undefined,
  activity: UserStoryAgentActivity,
  scopeId?: string
): Promise<UserStoryAgentActivity> {
  if (activity.detail.length <= maxPersistedDetailLength) return activity
  const artifact = await writeActivityArtifact(ownerId, sessionId, activity, scopeId)
  return {
    ...activity,
    detail: persistedDetailPreview(activity.detail),
    detailArtifact: artifact,
    detailTruncated: true,
    originalDetailLength: activity.detail.length,
  }
}

export async function artifactDetail(
  ownerId: string,
  workspace: string | null | undefined,
  activity: UserStoryAgentActivity
) {
  const reference = activity.detailArtifact
  if (!reference) return activity.detail
  if (reference.startsWith(objectReferencePrefix)) {
    return objectArtifactDetail(ownerId, reference, activity.detail)
  }
  return localArtifactDetail(workspace, reference, activity.detail)
}

export async function deleteActivityArtifacts(
  ownerId: string,
  activityGroups: Array<UserStoryAgentActivity[] | null | undefined>
) {
  const prefix = `agent-activities/${safeFilename(ownerId)}/`
  const keys = activityGroups
    .flatMap((activities) => activities ?? [])
    .map((activity) => activity.detailArtifact)
    .filter((reference): reference is string => Boolean(reference))
    .filter((reference) => reference.startsWith(objectReferencePrefix))
    .map((reference) => reference.slice(objectReferencePrefix.length))
    .filter((key) => key.startsWith(prefix))
  // Screenshots referenced by these activities go with them.
  keys.push(...screenshotKeysFromActivities(ownerId, activityGroups))
  if (keys.length) await workspaceArtifactObjectStorage().delete([...new Set(keys)])
}

async function writeActivityArtifact(
  ownerId: string,
  sessionId: string | null | undefined,
  activity: UserStoryAgentActivity,
  scopeId?: string
) {
  const content = Buffer.from(JSON.stringify(activity))
  const key = activityObjectKey(ownerId, sessionId, activity.id, scopeId)
  await workspaceArtifactObjectStorage().put(key, content, {
    checksumSha256: createHash('sha256').update(content).digest('hex'),
    contentType: 'application/vnd.blame.agent-activity+json',
    encryptionScope: ownerId,
    size: content.byteLength,
  })
  return `${objectReferencePrefix}${key}`
}

async function objectArtifactDetail(ownerId: string, reference: string, fallback: string) {
  try {
    const key = reference.slice(objectReferencePrefix.length)
    if (!key.startsWith(`agent-activities/${safeFilename(ownerId)}/`)) return fallback
    const storage = workspaceArtifactObjectStorage()
    const metadata = await storage.head(key)
    if (metadata.encryptionScope !== ownerId) return fallback
    const content = Buffer.from(await storage.content(key))
    if (metadata.checksumSha256 !== createHash('sha256').update(content).digest('hex')) {
      return fallback
    }
    return activityDetailFromJson(content.toString('utf8'), fallback)
  } catch {
    return fallback
  }
}

async function localArtifactDetail(
  workspace: string | null | undefined,
  path: string,
  fallback: string
) {
  if (!workspace || !isAbsolute(path)) return fallback
  if (!isPathInside(resolve(path), resolve(workspace))) return fallback
  try {
    return activityDetailFromJson(await readFile(path, 'utf8'), fallback)
  } catch {
    return fallback
  }
}

function activityDetailFromJson(value: string, fallback: string) {
  const artifact = JSON.parse(value) as UserStoryAgentActivity
  return typeof artifact.detail === 'string' ? artifact.detail : fallback
}

function activityObjectKey(
  ownerId: string,
  sessionId: string | null | undefined,
  id: string,
  scopeId?: string
) {
  return [
    'agent-activities',
    safeFilename(ownerId),
    safeFilename(sessionId ?? 'unknown-session'),
    ...(scopeId ? [safeFilename(scopeId)] : []),
    `${safeFilename(id).slice(0, 80)}-${createHash('sha256').update(id).digest('hex').slice(0, 16)}.json`,
  ].join('/')
}

function middleExcerpt(value: string, length: number) {
  if (value.length <= length) return value
  const edgeLength = Math.floor((length - 20) / 2)
  return `${value.slice(0, edgeLength)}\n...\n${value.slice(-edgeLength)}`
}

function persistedDetailPreview(value: string) {
  const parsed = parsedRecord(value)
  if (!parsed) return middleExcerpt(value, maxPersistedDetailLength)
  const bounded = JSON.stringify(
    boundedDetailRecord(parsed, maxPersistedDetailLength),
    undefined,
    2
  )
  if (bounded.length <= maxPersistedDetailLength) return bounded
  return JSON.stringify({
    excerpt: middleExcerpt(value, 1_200),
    originalLength: value.length,
    toolName: typeof parsed.toolName === 'string' ? parsed.toolName : undefined,
    truncated: true,
  })
}

function boundedDetailRecord(value: Record<string, unknown>, length: number) {
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .slice(0, 12)
  if (!entries.length) return {}
  const fieldLength = Math.max(120, Math.floor((length - 512) / entries.length) - 80)
  return Object.fromEntries(
    entries.map(([key, entry]) => [key, boundedDetailField(entry, fieldLength)])
  )
}

function boundedDetailField(value: unknown, length: number) {
  const serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  if (serialized.length <= length) return value
  return {
    excerpt: middleExcerpt(serialized, length),
    originalLength: serialized.length,
    truncated: true,
  }
}

function parsedRecord(value: string) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 160)
}

function isPathInside(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`)
}
