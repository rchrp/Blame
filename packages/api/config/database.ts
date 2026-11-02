import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'
import { useNodeSqliteDriver } from '#lib/sqlite/node_sqlite_driver'

const migrations = {
  naturalSort: true,
  paths: ['database/migrations'],
}

/**
 * MySQL backs the hosted API. SQLite backs the API that the desktop app runs
 * on the user's computer when they use Blame without an account.
 */
const connection = env.get('DB_CONNECTION', 'mysql')
if (connection === 'sqlite') useNodeSqliteDriver()

const dbConfig = defineConfig({
  connection,

  connections: {
    mysql: {
      client: 'mysql2',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        password: env.get('DB_PASSWORD'),
        database: env.get('DB_DATABASE'),
      },
      migrations,
      schemaGeneration: {
        enabled: true,
        rulesPaths: ['./database/schema_rules.js'],
      },
    },
    sqlite: {
      client: 'better-sqlite3',
      connection: { filename: env.get('DB_SQLITE_FILE', ':memory:') },
      useNullAsDefault: true,
      // One writer: SQLite serializes writes, and a single connection keeps
      // an in-memory test database shared by every query.
      pool: { min: 1, max: 1 },
      migrations,
      // database/schema.ts is generated from MySQL, the reference schema.
      schemaGeneration: { enabled: false },
    },
  },
})

export default dbConfig
