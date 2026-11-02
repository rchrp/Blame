import type { QueryClientContract } from '@adonisjs/lucid/types/database'

/**
 * True on the SQLite database of the API that runs on the desktop. Raw SQL in
 * migrations and services targets MySQL, the hosted database, unless it is
 * written for both.
 */
export function isSqlite(db: Pick<QueryClientContract, 'dialect'>) {
  return ['sqlite3', 'better-sqlite3', 'libsql'].includes(db.dialect.name)
}
