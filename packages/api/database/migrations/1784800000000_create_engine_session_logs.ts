import { BaseSchema } from '@adonisjs/lucid/schema'
import { isSqlite } from '#database/sql_dialect'

type TableBuilder = Parameters<Parameters<BaseSchema['schema']['createTable']>[1]>[0]

/**
 * Durable copy of the conversations of Blame's agent engine: an append-only
 * list of records per session, and the content-addressed blobs (images, large
 * tool output) the records point to. The engine chooses session ids and owns
 * record contents; these tables only keep them.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('engine_sessions', (table) => {
      this.sessionId(table, 'id').primary()
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.uuid('project_id').nullable().references('id').inTable('projects').onDelete('SET NULL')
      // What the session is for, read from its first record.
      table.string('purpose', 64).notNullable().defaultTo('')
      // Highest seq stored; records are contiguous from 1, so it is also the
      // count. Doubles as the per-session lock a push takes.
      table.bigInteger('head_seq').unsigned().notNullable().defaultTo(0)
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').notNullable()
      table.index(['user_id', 'updated_at'], 'engine_sessions_user_updated_idx')
      table.index(['project_id'], 'engine_sessions_project_idx')
    })

    this.schema.createTable('engine_session_records', (table) => {
      this.sessionId(table, 'session_id')
        .notNullable()
        .references('id')
        .inTable('engine_sessions')
        .onDelete('CASCADE')
      table.bigInteger('seq').unsigned().notNullable()
      table.string('type', 64).notNullable()
      // The engine's own timestamp (milliseconds since the Unix epoch).
      table.bigInteger('at_ms').unsigned().notNullable()
      // The record exactly as the engine sent it; never rewritten.
      table.text('body', 'longtext').notNullable()
      table.primary(['session_id', 'seq'])
    })

    this.schema.createTable('engine_blobs', (table) => {
      table.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('sha256', 64).notNullable()
      table.string('media_type', 255).notNullable()
      table.bigInteger('size').unsigned().notNullable()
      // Where the bytes are: a key in the object storage (files on disk for
      // the local API, encrypted S3-compatible storage when hosted).
      table.string('object_key', 255).notNullable().unique()
      table.timestamp('created_at').notNullable()
      table.primary(['owner_id', 'sha256'])
    })

    // Which blobs a session's records point to, read from the records, so a
    // deleted session only takes the blobs no other session of the user uses.
    this.schema.createTable('engine_session_blobs', (table) => {
      this.sessionId(table, 'session_id')
        .notNullable()
        .references('id')
        .inTable('engine_sessions')
        .onDelete('CASCADE')
      table.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('sha256', 64).notNullable()
      table.primary(['session_id', 'sha256'])
      table.index(['owner_id', 'sha256'], 'engine_session_blobs_owner_sha_idx')
    })
  }

  async down() {
    this.schema.dropTable('engine_session_blobs')
    this.schema.dropTable('engine_blobs')
    this.schema.dropTable('engine_session_records')
    this.schema.dropTable('engine_sessions')
  }

  /**
   * Session ids are chosen by the engine and compared exactly: MySQL's default
   * collation would treat `a` and `A` as the same session, SQLite never does.
   */
  private sessionId(table: TableBuilder, name: string) {
    const column = table.string(name, 64)
    if (!isSqlite(this.db)) column.collate('utf8mb4_bin')
    return column
  }
}
