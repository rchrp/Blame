import { createRequire } from 'node:module'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { DateTime } from 'luxon'

type Binding = null | number | bigint | string | NodeJS.ArrayBufferView

/**
 * The subset of the better-sqlite3 API that knex's `better-sqlite3` client
 * uses, implemented on Node's built-in `node:sqlite`. The local API runs
 * inside the desktop app, so it must not depend on a native module that
 * would have to be rebuilt for each Electron version and platform.
 */
class NodeSqliteStatement {
  readonly reader: boolean

  constructor(private statement: StatementSync) {
    this.reader = statement.columns().length > 0
  }

  safeIntegers(enabled: boolean) {
    this.statement.setReadBigInts(enabled)
    return this
  }

  all(bindings: Binding[]) {
    return this.statement.all(...bindings)
  }

  run(bindings: Binding[]) {
    const result = this.statement.run(...bindings)
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }
  }
}

export class NodeSqliteDatabase {
  private database: DatabaseSync

  constructor(filename: string, options: { readonly?: boolean } = {}) {
    this.database = new DatabaseSync(filename, { readOnly: Boolean(options.readonly) })
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.database.exec('PRAGMA foreign_keys = ON')
  }

  prepare(sql: string) {
    return new NodeSqliteStatement(this.database.prepare(sql))
  }

  defaultSafeIntegers(_enabled: boolean) {}

  close() {
    this.database.close()
  }
}

let installed = false

/**
 * Points knex's `better-sqlite3` client at `node:sqlite`. Lucid only accepts
 * client names, so the driver is swapped on the client knex resolves for that
 * name. Called once, from the database config, when SQLite is selected.
 */
export function useNodeSqliteDriver() {
  if (installed) return
  const lucidRequire = createRequire(import.meta.resolve('@adonisjs/lucid'))
  const knexRequire = createRequire(lucidRequire.resolve('knex'))
  const client = knexRequire('./lib/dialects/better-sqlite3/index.js') as {
    prototype: { _driver(): unknown; _formatBindings(bindings?: unknown[]): unknown[] }
  }
  client.prototype._driver = () => NodeSqliteDatabase
  client.prototype._formatBindings = formatBindings
  installed = true
}

/**
 * Dates are stored as text, the way Lucid writes DateTime columns, so a
 * column reads back the same whichever API wrote it. better-sqlite3's client
 * would store a JavaScript Date as epoch milliseconds.
 */
function sqlDateTime(date: Date) {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

function formatBindings(bindings: unknown[] = []) {
  return bindings.map((binding) => {
    if (binding instanceof Date) return sqlDateTime(binding)
    // mysql2 serializes Luxon values passed to the query builder; do the same.
    if (DateTime.isDateTime(binding)) return sqlDateTime(binding.toJSDate())
    if (typeof binding === 'boolean') return Number(binding)
    return binding
  })
}
