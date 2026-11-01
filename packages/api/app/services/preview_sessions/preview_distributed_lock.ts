import PreviewSession from '#models/preview_session'
import db from '@adonisjs/lucid/services/db'
import { PreviewRuntimeError, type DistributedLock, type LockLease } from '@blame/preview-runtime'
import { isSqlite } from '#database/sql_dialect'

// The SQLite API runs as one process on the desktop: an in-process queue per
// key gives the same exclusion as MySQL's named locks.
const localLocks = new Map<string, Promise<unknown>>()

export default class PreviewDistributedLock implements DistributedLock {
  async withLock<T>(key: string, operation: (lease: LockLease) => Promise<T>) {
    if (isSqlite(db.connection())) return this.withLocalLock(key, operation)
    const lockName = `blame-preview:${key}`.slice(0, 64)
    const knex = db.connection().getWriteClient()
    const connection = await knex.client.acquireConnection()
    try {
      const result = await knex
        .raw('SELECT GET_LOCK(?, 15) AS acquired', [lockName])
        .connection(connection)
      if (!mysqlBoolean(result, 'acquired')) {
        throw new PreviewRuntimeError({
          code: 'PROVIDER_UNAVAILABLE',
          message: 'Another preview operation is still finishing. Retry shortly.',
          providerCode: 'SESSION_LOCK_TIMEOUT',
          retryable: true,
        })
      }
      try {
        await PreviewSession.query().where('id', key).increment('fencingToken', 1)
        const session = await PreviewSession.query().where('id', key).firstOrFail()
        return await operation({ key, fencingToken: Number(session.fencingToken) })
      } finally {
        await knex.raw('SELECT RELEASE_LOCK(?) AS released', [lockName]).connection(connection)
      }
    } finally {
      await knex.client.releaseConnection(connection)
    }
  }

  private async withLocalLock<T>(key: string, operation: (lease: LockLease) => Promise<T>) {
    const previous = localLocks.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.lease(key, operation))
    localLocks.set(key, current)
    try {
      return await current
    } finally {
      if (localLocks.get(key) === current) localLocks.delete(key)
    }
  }

  private async lease<T>(key: string, operation: (lease: LockLease) => Promise<T>) {
    await PreviewSession.query().where('id', key).increment('fencingToken', 1)
    const session = await PreviewSession.query().where('id', key).firstOrFail()
    return operation({ key, fencingToken: Number(session.fencingToken) })
  }
}

function mysqlBoolean(result: unknown, key: string) {
  if (!Array.isArray(result)) return false
  const rows = result[0]
  if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== 'object') return false
  return Number((rows[0] as Record<string, unknown>)[key]) === 1
}
