import { attachmentsConfig, localStorageDirectory } from '#config/attachments'
import { FileObjectStorage } from '#services/file_object_storage'
import {
  MemoryObjectStorage,
  S3EncryptedObjectStorage,
  type BlameObjectStorage,
  type ObjectUploadTarget,
  type StoredObjectMetadata,
} from '#services/object_storage'

export type AttachmentObjectMetadata = StoredObjectMetadata
export type AttachmentUploadTarget = ObjectUploadTarget
export type AttachmentObjectStorage = BlameObjectStorage

let storage: AttachmentObjectStorage | undefined

export function attachmentObjectStorage() {
  storage ??= createAttachmentObjectStorage()
  return storage
}

function createAttachmentObjectStorage(): AttachmentObjectStorage {
  const config = attachmentsConfig()
  if (config.driver === 'memory') {
    return new MemoryObjectStorage(config.uploadUrlTtlSeconds, 'attachments')
  }
  if (config.driver === 'filesystem') {
    return new FileObjectStorage(localStorageDirectory('attachments'))
  }
  return new S3EncryptedObjectStorage({
    ...config.s3!,
    downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
    uploadUrlTtlSeconds: config.uploadUrlTtlSeconds,
  })
}
