import type { FileAttachmentReference } from '#lib/file_attachment'
import FileAttachment from '#models/file_attachment'
import PremiumService from '#services/premium_service'
import {
  attachmentObjectStorage,
  type AttachmentObjectMetadata,
} from '#services/attachment_object_storage'
import { attachmentsConfig } from '#config/attachments'
import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'

export type AttachmentOwnerType = keyof typeof ownerConfigs

type CreateUploadInput = Omit<FileAttachmentReference, 'content' | 'downloadUrl'> & {
  checksumSha256: string
}

const ownerConfigs = {
  quickChatMessage: {
    column: 'quick_chat_message_id',
    table: 'quick_chat_message_file_attachments',
  },
  userStory: {
    column: 'user_story_id',
    table: 'user_story_file_attachments',
  },
  userStoryComment: {
    column: 'user_story_comment_id',
    table: 'user_story_comment_file_attachments',
  },
} as const

export default class FileAttachmentsService {
  private config = attachmentsConfig()
  private storage = attachmentObjectStorage()

  async createUpload(userId: string, input: CreateUploadInput) {
    await new PremiumService().assert(userId, 'cloud_storage')
    this.validateMetadata(input)
    const existing = await FileAttachment.find(input.id)
    if (existing) return this.existingUpload(userId, existing, input)
    const attachment = await FileAttachment.create(this.pendingRecord(userId, input))
    try {
      return {
        attachment: this.reference(attachment),
        upload: await this.storage.presignUpload(attachment.objectKey, objectMetadata(attachment)),
      }
    } catch (error) {
      await attachment.delete()
      throw error
    }
  }

  async completeUpload(userId: string, id: string) {
    const attachment = await this.findForUser(userId, id)
    if (attachment.status === 'ready') return this.deliver(attachment)
    const stored = await this.storage.head(attachment.objectKey)
    this.assertStoredMetadata(attachment, stored)
    attachment.merge({
      detachedAt: DateTime.utc(),
      status: 'ready',
      uploadedAt: DateTime.utc(),
    })
    await attachment.save()
    return this.deliver(attachment)
  }

  async deliverForUser(userId: string, id: string) {
    return this.deliver(await this.findReadyForUser(userId, id))
  }

  async resolveInputs(
    userId: string,
    inputs: FileAttachmentReference[] | null | undefined,
    options: { migrateExisting?: boolean } = {}
  ) {
    if (!inputs?.length) return []
    const resolved: FileAttachment[] = []
    for (const input of inputs) {
      resolved.push(await this.resolveInput(userId, input, options.migrateExisting === true))
    }
    return resolved
  }

  async syncOwner(
    userId: string,
    ownerType: AttachmentOwnerType,
    ownerId: string,
    attachments: FileAttachment[],
    transaction: TransactionClientContract
  ) {
    this.assertUnique(attachments)
    await this.assertOwnedReady(userId, attachments, transaction)
    const removedIds = await this.replaceLinks(ownerType, ownerId, attachments, transaction)
    await this.markAttached(attachments, transaction)
    await this.markDetached(removedIds, transaction)
  }

  async prepareDownloads(attachments: FileAttachment[]) {
    await Promise.all(
      attachments.map(async (attachment) => {
        attachment.downloadUrl = await this.storage.presignDownload(
          attachment.objectKey,
          attachment.name
        )
      })
    )
  }

  async contentBase64(attachment: FileAttachment) {
    return Buffer.from(await this.storage.content(attachment.objectKey)).toString('base64')
  }

  async contentByObjectKey(objectKey: string) {
    return Buffer.from(await this.storage.content(objectKey)).toString('base64')
  }

  async deleteAllForUser(userId: string) {
    const attachments = await FileAttachment.query().where('userId', userId)
    await this.storage.delete(attachments.map((attachment) => attachment.objectKey))
    if (attachments.length) {
      await FileAttachment.query()
        .whereIn(
          'id',
          attachments.map((attachment) => attachment.id)
        )
        .delete()
    }
  }

  async cleanupOrphans(limit = 500) {
    const candidates = await this.orphanCandidates(limit)
    const unlinked = await this.unlinked(candidates)
    await this.storage.delete(unlinked.map((attachment) => attachment.objectKey))
    if (unlinked.length) {
      await FileAttachment.query()
        .whereIn(
          'id',
          unlinked.map((attachment) => attachment.id)
        )
        .delete()
    }
    return unlinked.length
  }

  async markOwnersDetached(
    ownerType: AttachmentOwnerType,
    ownerIds: string[],
    transaction?: TransactionClientContract
  ) {
    if (!ownerIds.length) return
    const config = ownerConfigs[ownerType]
    const client = transaction ?? db
    const rows = await client
      .from(config.table)
      .select('file_attachment_id')
      .whereIn(config.column, ownerIds)
    await this.markDetached(
      rows.map((row) => String(row.file_attachment_id)),
      transaction
    )
  }

  private async resolveInput(
    userId: string,
    input: FileAttachmentReference,
    migrateExisting: boolean
  ) {
    if (input.content !== undefined) return this.ingestInline(userId, input, migrateExisting)
    return this.findReadyForUser(userId, input.id)
  }

  private async ingestInline(
    userId: string,
    input: FileAttachmentReference,
    migrateExisting: boolean
  ) {
    const content = decodeBase64(input.content ?? '')
    const checksumSha256 = sha256(content)
    const upload = { ...input, checksumSha256 }
    this.validateMetadata(upload)
    if (content.byteLength !== input.size) throw invalidAttachment('Attachment size does not match')
    const existing = await FileAttachment.find(input.id)
    if (existing) return this.assertExisting(userId, existing, upload)
    if (!migrateExisting) await new PremiumService().assert(userId, 'cloud_storage')
    return this.storeInline(userId, upload, content)
  }

  private async storeInline(userId: string, input: CreateUploadInput, content: Uint8Array) {
    const attachment = await FileAttachment.create(this.pendingRecord(userId, input))
    try {
      await this.storage.put(attachment.objectKey, content, objectMetadata(attachment))
      attachment.merge({
        detachedAt: DateTime.utc(),
        status: 'ready',
        uploadedAt: DateTime.utc(),
      })
      await attachment.save()
      return attachment
    } catch (error) {
      await attachment.delete()
      await this.storage.delete([attachment.objectKey]).catch(() => undefined)
      throw error
    }
  }

  private async existingUpload(
    userId: string,
    attachment: FileAttachment,
    input: CreateUploadInput
  ) {
    this.assertExisting(userId, attachment, input)
    if (attachment.status === 'ready') {
      return { attachment: await this.deliver(attachment), upload: null }
    }
    return {
      attachment: this.reference(attachment),
      upload: await this.storage.presignUpload(attachment.objectKey, objectMetadata(attachment)),
    }
  }

  private assertExisting(userId: string, attachment: FileAttachment, input: CreateUploadInput) {
    if (
      attachment.userId !== userId ||
      attachment.checksumSha256 !== input.checksumSha256 ||
      attachment.name !== input.name ||
      attachment.mimeType !== normalizedType(input.type) ||
      attachment.size !== input.size
    ) {
      throw invalidAttachment('Attachment identifier is already in use', 409)
    }
    return attachment
  }

  private pendingRecord(userId: string, input: CreateUploadInput) {
    return {
      checksumSha256: input.checksumSha256,
      detachedAt: null,
      id: input.id,
      mimeType: normalizedType(input.type),
      name: input.name,
      objectKey: `${userId}/${input.id}`,
      size: input.size,
      status: 'pending' as const,
      uploadedAt: null,
      userId,
    }
  }

  private validateMetadata(input: CreateUploadInput) {
    if (input.size < 0 || input.size > this.config.maxBytes) {
      throw invalidAttachment(
        `Attachment size must be between 0 and ${this.config.maxBytes} bytes`,
        413
      )
    }
    if (!/^[a-f0-9]{64}$/.test(input.checksumSha256)) {
      throw invalidAttachment('Attachment checksum is invalid')
    }
  }

  private assertStoredMetadata(attachment: FileAttachment, stored: AttachmentObjectMetadata) {
    if (
      stored.size !== attachment.size ||
      stored.contentType !== attachment.mimeType ||
      stored.checksumSha256 !== attachment.checksumSha256
    ) {
      throw invalidAttachment('Uploaded attachment metadata does not match', 409)
    }
  }

  private async deliver(attachment: FileAttachment) {
    await this.prepareDownloads([attachment])
    return this.reference(attachment)
  }

  private reference(attachment: FileAttachment): FileAttachmentReference {
    return {
      ...(attachment.downloadUrl ? { downloadUrl: attachment.downloadUrl } : {}),
      id: attachment.id,
      name: attachment.name,
      size: attachment.size,
      type: attachment.mimeType,
    }
  }

  private findForUser(userId: string, id: string) {
    return FileAttachment.query().where('id', id).where('userId', userId).firstOrFail()
  }

  private findReadyForUser(userId: string, id: string) {
    return FileAttachment.query()
      .where('id', id)
      .where('userId', userId)
      .where('status', 'ready')
      .firstOrFail()
  }

  private assertUnique(attachments: FileAttachment[]) {
    if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) {
      throw invalidAttachment('Duplicate attachment identifiers are not allowed')
    }
  }

  private async assertOwnedReady(
    userId: string,
    attachments: FileAttachment[],
    transaction: TransactionClientContract
  ) {
    if (!attachments.length) return
    const count = await FileAttachment.query({ client: transaction })
      .where('userId', userId)
      .where('status', 'ready')
      .whereIn(
        'id',
        attachments.map((attachment) => attachment.id)
      )
      .count('* as total')
    if (Number(count[0]?.$extras.total ?? 0) !== attachments.length) {
      throw invalidAttachment('One or more attachments are unavailable', 409)
    }
  }

  private async replaceLinks(
    ownerType: AttachmentOwnerType,
    ownerId: string,
    attachments: FileAttachment[],
    transaction: TransactionClientContract
  ) {
    const config = ownerConfigs[ownerType]
    const existing = await transaction
      .from(config.table)
      .select('file_attachment_id')
      .where(config.column, ownerId)
    await transaction.from(config.table).where(config.column, ownerId).delete()
    if (attachments.length) {
      await transaction.table(config.table).multiInsert(
        attachments.map((attachment, position) => ({
          [config.column]: ownerId,
          file_attachment_id: attachment.id,
          position,
        }))
      )
    }
    return removedAttachmentIds(existing, attachments)
  }

  private async markAttached(
    attachments: FileAttachment[],
    transaction: TransactionClientContract
  ) {
    if (!attachments.length) return
    await FileAttachment.query({ client: transaction })
      .whereIn(
        'id',
        attachments.map((attachment) => attachment.id)
      )
      .update({ detachedAt: null })
  }

  private async markDetached(ids: string[], transaction?: TransactionClientContract) {
    if (!ids.length) return
    await FileAttachment.query({ client: transaction })
      .whereIn('id', ids)
      .update({ detachedAt: DateTime.utc().toJSDate() })
  }

  private orphanCandidates(limit: number) {
    const cutoff = DateTime.utc().minus({ hours: this.config.orphanGraceHours })
    return FileAttachment.query()
      .where((query) =>
        query
          .where((pending) =>
            pending.where('status', 'pending').where('createdAt', '<=', cutoff.toJSDate())
          )
          .orWhere((ready) =>
            ready.where('status', 'ready').where('detachedAt', '<=', cutoff.toJSDate())
          )
      )
      .orderBy('createdAt', 'asc')
      .limit(limit)
  }

  private async unlinked(candidates: FileAttachment[]) {
    if (!candidates.length) return []
    const ids = candidates.map((attachment) => attachment.id)
    const linked = new Set<string>()
    for (const config of Object.values(ownerConfigs)) {
      const rows = await db
        .from(config.table)
        .select('file_attachment_id')
        .whereIn('file_attachment_id', ids)
      rows.forEach((row) => linked.add(String(row.file_attachment_id)))
    }
    return candidates.filter((attachment) => !linked.has(attachment.id))
  }
}

function decodeBase64(content: string) {
  if (!isBase64(content)) {
    throw invalidAttachment('Attachment content is not valid base64')
  }
  return Buffer.from(content, 'base64')
}

function isBase64(content: string) {
  if (content.length % 4 !== 0) return false
  const paddingLength = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0
  const dataLength = content.length - paddingLength
  for (let index = 0; index < dataLength; index++) {
    if (!isBase64Character(content.charCodeAt(index))) return false
  }
  return true
}

function isBase64Character(character: number) {
  return (
    (character >= 65 && character <= 90) ||
    (character >= 97 && character <= 122) ||
    (character >= 48 && character <= 57) ||
    character === 43 ||
    character === 47
  )
}

function invalidAttachment(message: string, status = 422) {
  return new Exception(message, { code: 'E_FILE_ATTACHMENT_INVALID', status })
}

function normalizedType(type: string) {
  return type.trim() || 'application/octet-stream'
}

function objectMetadata(attachment: FileAttachment): AttachmentObjectMetadata {
  return {
    checksumSha256: attachment.checksumSha256,
    contentType: attachment.mimeType,
    size: attachment.size,
  }
}

function removedAttachmentIds(rows: Record<string, unknown>[], attachments: FileAttachment[]) {
  const retained = new Set(attachments.map((attachment) => attachment.id))
  return rows.map((row) => String(row.file_attachment_id)).filter((id) => !retained.has(id))
}

function sha256(content: Uint8Array) {
  return createHash('sha256').update(content).digest('hex')
}
