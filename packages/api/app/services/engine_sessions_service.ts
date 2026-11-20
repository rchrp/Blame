import { engineSessionsConfig } from '#config/engine_sessions'
import EngineLogException from '#lib/engine/engine_log_exception'
import {
  blobHashes,
  parseRecords,
  purposeOf,
  sameRecord,
  type ParsedRecord,
} from '#lib/engine/engine_log_records'
import EngineSession from '#models/engine_session'
import Project from '#models/project'
import { workspaceArtifactObjectStorage } from '#services/workspace_artifacts/workspace_artifact_object_storage'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'

const insertChunk = 100

export type PushInput = {
  /** The raw `records` array of the request, not yet checked. */
  records: unknown
  /** The Blame project the session works on, when the client knows it. */
  projectId?: string | null
}

export type PulledRecords = {
  /** Each entry is a record's stored JSON, exactly as it was pushed. */
  bodies: string[]
  head: number
  hasMore: boolean
}

/**
 * Keeps the engine's session logs. A session belongs to the user who pushed
 * its first record; everything here is scoped by that user and refuses any
 * other.
 */
export default class EngineSessionsService {
  private config = engineSessionsConfig()

  /**
   * Stores the records the session does not hold yet and answers the highest
   * seq held with no gap before it. Pushes of one session run one at a time,
   * because each takes the session's row lock (MySQL) or the database's write
   * lock (SQLite) before it reads the head.
   */
  async push(userId: string, sessionId: string, input: PushInput) {
    const records = parseRecords(input.records, this.config.maxPushRecords)
    if (!records.length) {
      const session = await this.ownedSession(userId, sessionId)
      return { acked: session?.headSeq ?? 0 }
    }
    if (input.projectId) await this.assertProject(userId, input.projectId)
    await this.createIfMissing(userId, sessionId, input.projectId ?? null)
    return withDeadlockRetry(() =>
      db.transaction((transaction) =>
        this.appendLocked(transaction, userId, sessionId, records, input.projectId ?? null)
      )
    )
  }

  /** Records after `after`, ascending; an unknown session has none. */
  async pull(
    userId: string,
    sessionId: string,
    after: number,
    requestedLimit: number | undefined
  ): Promise<PulledRecords> {
    const session = await this.ownedSession(userId, sessionId)
    if (!session) return { bodies: [], head: 0, hasMore: false }
    const limit = Math.min(
      Math.max(requestedLimit ?? this.config.maxPullRecords, 1),
      this.config.maxPullRecords
    )
    const rows = await db
      .from('engine_session_records')
      .select('seq', 'body')
      .where('session_id', sessionId)
      .where('seq', '>', after)
      .orderBy('seq', 'asc')
      .limit(limit)
    const bodies: string[] = []
    let bytes = 0
    let last = after
    for (const row of rows) {
      // The first record is always returned, so a huge one cannot stall a pull.
      if (bodies.length && bytes + row.body.length > this.config.maxPullBytes) break
      bodies.push(row.body)
      bytes += row.body.length
      last = Number(row.seq)
    }
    return { bodies, head: session.headSeq, hasMore: last < session.headSeq }
  }

  list(userId: string, limit = 100) {
    return (
      EngineSession.query()
        .where('userId', userId)
        // A first push refused for a gap leaves an empty row: not a session yet.
        .where('headSeq', '>', 0)
        .orderBy('updatedAt', 'desc')
        .orderBy('id', 'asc')
        .limit(Math.min(Math.max(limit, 1), 500))
    )
  }

  /** Deletes a session with its records, and the blobs no other session of the user uses. */
  async destroy(userId: string, sessionId: string) {
    const orphanedKeys = await db.transaction(async (transaction) => {
      const session = await this.lock(transaction, sessionId)
      if (!session) {
        throw new EngineLogException('E_ENGINE_SESSION_NOT_FOUND', 'Session not found', 404)
      }
      this.assertOwner(session, userId)
      const links = await transaction
        .from('engine_session_blobs')
        .select('sha256')
        .where('session_id', sessionId)
      const linked = links.map((row) => String(row.sha256))
      await transaction.from('engine_session_records').where('session_id', sessionId).delete()
      await transaction.from('engine_session_blobs').where('session_id', sessionId).delete()
      await transaction.from('engine_sessions').where('id', sessionId).delete()
      return this.deleteUnusedBlobs(transaction, userId, linked)
    })
    await this.deleteObjects(orphanedKeys)
  }

  /** Every blob of the user, for the closure of an account (the rows follow the user). */
  async deleteAllBlobsForUser(userId: string) {
    const rows = await db.from('engine_blobs').select('object_key').where('owner_id', userId)
    await workspaceArtifactObjectStorage().delete(rows.map((row) => String(row.object_key)))
  }

  /** Stores a blob after checking its bytes against the hash; storing it again changes nothing. */
  async putBlob(userId: string, sha256: string, mediaType: string, bytes: Buffer) {
    if (bytes.byteLength > this.config.maxBlobBytes) {
      throw new EngineLogException(
        'E_ENGINE_PAYLOAD_TOO_LARGE',
        `A blob is at most ${this.config.maxBlobBytes} bytes`,
        413
      )
    }
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new EngineLogException(
        'E_ENGINE_BLOB_HASH_MISMATCH',
        'The bytes do not match the SHA-256 in the path',
        422
      )
    }
    const existing = await this.findBlob(userId, sha256)
    if (existing)
      return { created: false, size: Number(existing.size), mediaType: existing.media_type }
    const objectKey = blobObjectKey(userId, sha256)
    await workspaceArtifactObjectStorage().put(objectKey, bytes, {
      checksumSha256: sha256,
      contentType: mediaType,
      encryptionScope: userId,
      size: bytes.byteLength,
    })
    // A concurrent push of the same blob wrote the same bytes to the same key,
    // so whichever insert loses the race has nothing left to do.
    await db
      .table('engine_blobs')
      .insert({
        owner_id: userId,
        sha256,
        media_type: mediaType,
        size: bytes.byteLength,
        object_key: objectKey,
        created_at: timestamp(db.connection()),
      })
      .onConflict(['owner_id', 'sha256'])
      .ignore()
    return { created: true, size: bytes.byteLength, mediaType }
  }

  async blob(userId: string, sha256: string) {
    const row = await this.findBlob(userId, sha256)
    if (!row) throw new EngineLogException('E_ENGINE_BLOB_NOT_FOUND', 'Blob not found', 404)
    try {
      const content = await workspaceArtifactObjectStorage().content(row.object_key)
      return { bytes: Buffer.from(content), mediaType: String(row.media_type) }
    } catch {
      throw new EngineLogException('E_ENGINE_BLOB_NOT_FOUND', 'Blob not found', 404)
    }
  }

  private async appendLocked(
    transaction: TransactionClientContract,
    userId: string,
    sessionId: string,
    records: ParsedRecord[],
    projectId: string | null
  ) {
    const session = await this.lock(transaction, sessionId)
    if (!session)
      throw new EngineLogException('E_ENGINE_SESSION_NOT_FOUND', 'Session not found', 404)
    this.assertOwner(session, userId)
    const head = Number(session.head_seq)
    const first = records[0]!.seq
    if (first > head + 1) {
      throw new EngineLogException(
        'E_ENGINE_LOG_GAP',
        `The log holds records up to ${head}, so a push cannot start at ${first}`,
        409,
        { acked: head }
      )
    }
    await this.assertHeldRecordsMatch(transaction, sessionId, records, head)
    const fresh = records.filter((record) => record.seq > head)
    if (!fresh.length) return { acked: head }

    for (const chunk of chunks(fresh, insertChunk)) {
      await transaction.table('engine_session_records').multiInsert(
        chunk.map((record) => ({
          session_id: sessionId,
          seq: record.seq,
          type: record.type,
          at_ms: record.atMs,
          body: record.body,
        }))
      )
    }
    await this.linkBlobs(transaction, userId, sessionId, fresh)

    const acked = fresh[fresh.length - 1]!.seq
    const created = fresh.find((record) => record.seq === 1)
    await transaction
      .from('engine_sessions')
      .where('id', sessionId)
      .update({
        head_seq: acked,
        updated_at: timestamp(transaction),
        ...(created && purposeOf(created) !== null ? { purpose: purposeOf(created) } : {}),
        ...(projectId && !session.project_id ? { project_id: projectId } : {}),
      })
    return { acked }
  }

  /** Records the push repeats must be the ones already held, whatever the key order. */
  private async assertHeldRecordsMatch(
    transaction: TransactionClientContract,
    sessionId: string,
    records: ParsedRecord[],
    head: number
  ) {
    const repeated = records.filter((record) => record.seq <= head)
    if (!repeated.length) return
    const rows = await transaction
      .from('engine_session_records')
      .select('seq', 'body')
      .where('session_id', sessionId)
      .whereBetween('seq', [repeated[0]!.seq, repeated[repeated.length - 1]!.seq])
    const stored = new Map(rows.map((row) => [Number(row.seq), String(row.body)]))
    for (const record of repeated) {
      const body = stored.get(record.seq)
      if (body === undefined || !sameRecord(body, record)) {
        throw new EngineLogException(
          'E_ENGINE_LOG_CONFLICT',
          `Record ${record.seq} differs from the one already stored`,
          409,
          { seq: record.seq, acked: head }
        )
      }
    }
  }

  private async linkBlobs(
    transaction: TransactionClientContract,
    userId: string,
    sessionId: string,
    records: ParsedRecord[]
  ) {
    const hashes = new Set<string>()
    for (const record of records) blobHashes(record.value, hashes)
    for (const chunk of chunks([...hashes], insertChunk)) {
      await transaction
        .table('engine_session_blobs')
        .insert(chunk.map((sha256) => ({ session_id: sessionId, owner_id: userId, sha256 })))
        .onConflict(['session_id', 'sha256'])
        .ignore()
    }
  }

  /** Removes the rows of blobs no session of the user links to and returns their object keys. */
  private async deleteUnusedBlobs(
    transaction: TransactionClientContract,
    userId: string,
    candidates: string[]
  ) {
    const keys: string[] = []
    for (const chunk of chunks(candidates, 500)) {
      const unused = await transaction
        .from('engine_blobs')
        .select('sha256', 'object_key')
        .where('owner_id', userId)
        .whereIn('sha256', chunk)
        .whereNotExists((query) =>
          query
            .from('engine_session_blobs')
            .select(db.raw('1'))
            .where('engine_session_blobs.owner_id', userId)
            .whereRaw('engine_session_blobs.sha256 = engine_blobs.sha256')
        )
      if (!unused.length) continue
      await transaction
        .from('engine_blobs')
        .where('owner_id', userId)
        .whereIn(
          'sha256',
          unused.map((row) => row.sha256)
        )
        .delete()
      keys.push(...unused.map((row) => String(row.object_key)))
    }
    return keys
  }

  private async deleteObjects(keys: string[]) {
    if (!keys.length) return
    try {
      await workspaceArtifactObjectStorage().delete(keys)
    } catch (error) {
      // The rows are gone; the bytes of these keys are orphans to sweep later.
      logger.error({ err: error, keys }, 'Engine blobs could not be deleted from object storage')
    }
  }

  /**
   * Creates the session row with its owner before the locked transaction
   * starts: locking a row that does not exist yet makes two first pushes
   * deadlock on MySQL. Losing the creation race is fine, the row exists.
   */
  private async createIfMissing(userId: string, sessionId: string, projectId: string | null) {
    const existing = await this.ownedSession(userId, sessionId)
    if (existing) return
    const now = timestamp(db.connection())
    await db
      .table('engine_sessions')
      .insert({
        id: sessionId,
        user_id: userId,
        project_id: projectId,
        purpose: '',
        head_seq: 0,
        created_at: now,
        updated_at: now,
      })
      .onConflict('id')
      .ignore()
  }

  /** The session when it exists and is the user's; a session of someone else is refused. */
  private async ownedSession(userId: string, sessionId: string) {
    const session = await EngineSession.find(sessionId)
    if (session) this.assertOwner({ user_id: session.userId }, userId)
    return session
  }

  private assertOwner(session: { user_id: string }, userId: string) {
    if (session.user_id !== userId) {
      throw new EngineLogException(
        'E_ENGINE_SESSION_FORBIDDEN',
        'This session belongs to another account',
        403
      )
    }
  }

  /** The session row, locked until the transaction ends. */
  private lock(transaction: TransactionClientContract, sessionId: string) {
    return transaction.from('engine_sessions').where('id', sessionId).forUpdate().first()
  }

  private async assertProject(userId: string, projectId: string) {
    const project = await Project.query().where('id', projectId).where('userId', userId).first()
    if (!project) {
      throw new EngineLogException('E_ENGINE_PROJECT_NOT_FOUND', 'Project not found', 404)
    }
  }

  private findBlob(userId: string, sha256: string) {
    return db.from('engine_blobs').where('owner_id', userId).where('sha256', sha256).first()
  }
}

/** A timestamp written the way Lucid writes one, so models read it back on either database. */
function timestamp(client: Pick<TransactionClientContract, 'dialect'>) {
  return DateTime.utc().toFormat(client.dialect.dateTimeFormat)
}

export function blobObjectKey(userId: string, sha256: string) {
  return `engine-blobs/${userId}/${sha256}`
}

function chunks<T>(values: T[], size: number) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size)
  )
}

/** MySQL aborts one of two transactions that lock rows in opposite orders; the loser can run again. */
async function withDeadlockRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      const code = (error as { errno?: number; code?: string }).errno
      if (attempt >= attempts || (code !== 1213 && code !== 1205)) throw error
    }
  }
}
