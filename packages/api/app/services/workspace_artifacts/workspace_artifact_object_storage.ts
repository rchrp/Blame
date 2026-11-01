import { workspaceArtifactsConfig } from '#config/workspace_artifacts'
import { localStorageDirectory } from '#config/attachments'
import { FileObjectStorage } from '#services/file_object_storage'
import {
  MemoryObjectStorage,
  S3EncryptedObjectStorage,
  type BlameObjectStorage,
  type StoredObjectMetadata,
} from '#services/object_storage'

let workspaceStorage: BlameObjectStorage | undefined

export function workspaceArtifactObjectStorage() {
  workspaceStorage ??= createWorkspaceArtifactObjectStorage()
  return workspaceStorage
}

function createWorkspaceArtifactObjectStorage(): BlameObjectStorage {
  const config = workspaceArtifactsConfig()
  if (config.driver === 'memory') {
    return new MemoryObjectStorage(config.uploadUrlTtlSeconds, 'workspace-artifacts')
  }
  if (config.driver === 'filesystem') {
    return new FileObjectStorage(localStorageDirectory('workspace-artifacts'))
  }
  return new EncryptedWorkspaceObjectStorage(
    new S3EncryptedObjectStorage({
      ...config.s3!,
      downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
      uploadUrlTtlSeconds: config.uploadUrlTtlSeconds,
    })
  )
}

class EncryptedWorkspaceObjectStorage implements BlameObjectStorage {
  constructor(private readonly delegate: BlameObjectStorage) {}

  content(key: string) {
    return this.delegate.content(key)
  }

  delete(keys: string[]) {
    return this.delegate.delete(keys)
  }

  async head(key: string) {
    const metadata = await this.delegate.head(key)
    assertWorkspaceArtifactEncryption(metadata)
    return metadata
  }

  presignDownload(key: string, name: string) {
    return this.delegate.presignDownload(key, name)
  }

  presignUpload(key: string, metadata: StoredObjectMetadata) {
    return this.delegate.presignUpload(key, metadata)
  }

  put(key: string, content: Uint8Array, metadata: StoredObjectMetadata) {
    return this.delegate.put(key, content, metadata)
  }
}

export function assertWorkspaceArtifactEncryption(metadata: StoredObjectMetadata) {
  if (metadata.serverSideEncryption !== 'AES256') {
    throw new Error('Workspace artifact is not encrypted with OVH SSE-OMK.')
  }
}
