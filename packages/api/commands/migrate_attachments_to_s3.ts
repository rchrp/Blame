import type { FileAttachmentReference } from '#lib/file_attachment'
import FileAttachmentsService, {
  type AttachmentOwnerType,
} from '#services/file_attachments_service'
import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'

type LegacyOwner = {
  file_attachments: unknown
  id: string
  user_id: string
}

type LegacySource = {
  owners: (ownerIds: string[]) => Promise<LegacyOwner[]>
  ownerType: AttachmentOwnerType
  table: string
}

const migrationBatchSize = 100

export default class MigrateAttachmentsToS3 extends BaseCommand {
  static commandName = 'attachments:migrate-to-s3'
  static description = 'Move legacy inline message attachments to S3-compatible object storage'
  static options: CommandOptions = { startApp: true }

  async run() {
    const migratedOwners = await migrateLegacyAttachments()
    this.logger.success(`Migrated ${migratedOwners} attachment owners to object storage`)
  }
}

export async function migrateLegacyAttachments() {
  const service = new FileAttachmentsService()
  let migratedOwners = 0
  for (const source of sources()) {
    migratedOwners += await migrateSource(service, source)
  }
  return migratedOwners
}

async function migrateSource(service: FileAttachmentsService, source: LegacySource) {
  let afterId: string | undefined
  let migratedOwners = 0
  while (true) {
    const ownerIds = await legacyOwnerIds(source.table, afterId, migrationBatchSize)
    if (!ownerIds.length) return migratedOwners
    const owners = orderOwners(await source.owners(ownerIds), ownerIds, source.table)
    for (const owner of owners) await migrateOwner(service, source, owner)
    migratedOwners += owners.length
    afterId = ownerIds.at(-1)!
  }
}

async function migrateOwner(
  service: FileAttachmentsService,
  source: LegacySource,
  owner: LegacyOwner
) {
  const inputs = legacyAttachments(owner.file_attachments)
  const attachments = await service.resolveInputs(owner.user_id, inputs, { migrateExisting: true })
  await db.transaction(async (transaction) => {
    await service.syncOwner(owner.user_id, source.ownerType, owner.id, attachments, transaction)
    await transaction.from(source.table).where('id', owner.id).update({ file_attachments: null })
  })
}

function sources(): LegacySource[] {
  return [
    {
      owners: userStories,
      ownerType: 'userStory',
      table: 'user_stories',
    },
    {
      owners: userStoryComments,
      ownerType: 'userStoryComment',
      table: 'user_story_comments',
    },
  ]
}

async function userStories(ownerIds: string[]) {
  return db
    .from('user_stories as owner')
    .innerJoin('projects as project', 'project.id', 'owner.project_id')
    .select(['owner.id', 'owner.file_attachments', 'project.user_id'])
    .whereIn('owner.id', ownerIds)
}

async function userStoryComments(ownerIds: string[]) {
  return db
    .from('user_story_comments as owner')
    .innerJoin('user_stories as story', 'story.id', 'owner.user_story_id')
    .innerJoin('projects as project', 'project.id', 'story.project_id')
    .select(['owner.id', 'owner.file_attachments', 'project.user_id'])
    .whereIn('owner.id', ownerIds)
}

async function legacyOwnerIds(table: string, afterId: string | undefined, limit: number) {
  const query = db.from(table).select('id').whereNotNull('file_attachments')
  if (afterId) query.where('id', '>', afterId)
  const rows = await query.orderBy('id', 'asc').limit(limit)
  return rows.map((row) => row.id as string)
}

function orderOwners(owners: LegacyOwner[], ownerIds: string[], table: string) {
  const ownersById = new Map(owners.map((owner) => [owner.id, owner]))
  return ownerIds.map((ownerId) => {
    const owner = ownersById.get(ownerId)
    if (!owner) throw new Error(`Unable to resolve attachment owner ${table}.${ownerId}`)
    return owner
  })
}

function legacyAttachments(value: unknown): FileAttachmentReference[] {
  const parsed = typeof value === 'string' ? parseJson(value) : value
  if (!Array.isArray(parsed) || !parsed.every(isLegacyAttachment)) {
    throw new Error('Legacy attachment payload is invalid')
  }
  return parsed
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error('Legacy attachment payload is not valid JSON')
  }
}

function isLegacyAttachment(value: unknown): value is FileAttachmentReference {
  if (!value || typeof value !== 'object') return false
  const attachment = value as Record<string, unknown>
  return (
    typeof attachment.id === 'string' &&
    typeof attachment.content === 'string' &&
    typeof attachment.name === 'string' &&
    typeof attachment.size === 'number' &&
    typeof attachment.type === 'string'
  )
}
