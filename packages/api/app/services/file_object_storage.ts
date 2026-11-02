import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BlameObjectStorage,
  ObjectUploadTarget,
  StoredObjectMetadata,
} from '#services/object_storage'

/**
 * Objects stored as files, for the local API: agent screenshots and activity
 * details stay on the user's computer. Signed URLs belong to hosted storage,
 * which hosted uploads use: the local API refuses those uploads first.
 */
export class FileObjectStorage implements BlameObjectStorage {
  constructor(private readonly directory: string) {}

  async content(key: string) {
    return new Uint8Array(await stored(readFile(this.path(key))))
  }

  async delete(keys: string[]) {
    await Promise.all(
      keys.flatMap((key) => [
        rm(this.path(key), { force: true }),
        rm(this.metadataPath(key), { force: true }),
      ])
    )
  }

  async head(key: string): Promise<StoredObjectMetadata> {
    return JSON.parse(await stored(readFile(this.metadataPath(key), 'utf8')))
  }

  async presignDownload(): Promise<string> {
    throw new Error('Signed downloads need hosted storage')
  }

  async presignUpload(): Promise<ObjectUploadTarget> {
    throw new Error('Signed uploads need hosted storage')
  }

  async put(key: string, content: Uint8Array, metadata: StoredObjectMetadata) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await writeFile(this.path(key), content, { mode: 0o600 })
    await writeFile(this.metadataPath(key), JSON.stringify(metadata), { mode: 0o600 })
  }

  private path(key: string) {
    return join(this.directory, createHash('sha256').update(key).digest('hex'))
  }

  private metadataPath(key: string) {
    return `${this.path(key)}.json`
  }
}

async function stored<T>(read: Promise<T>) {
  try {
    return await read
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('Stored object not found')
    throw error
  }
}
