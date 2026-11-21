import { BaseSchema } from '@adonisjs/lucid/schema'
import { isSqlite } from '#database/sql_dialect'

/**
 * Epics, the goals the orchestrator works on, and what a story needs to be
 * part of one: the stories it waits for, the model its first run must use
 * and the intent that chose it.
 *
 * `starts_after` holds story ids with no foreign key: a story that others
 * wait for can be deleted, and the ids stay in their lists. `epic_id` has none
 * either (SQLite would rebuild the table); deleting an epic clears it.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('epics', (table) => {
      table.uuid('id').primary()
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.string('title').notNullable()
      table.text('goal').nullable()
      table.string('status', 16).notNullable().defaultTo('active')
      table.string('branch', 255).nullable()
      table.string('target_branch', 255).nullable()
      // The orchestrator's conversation, an engine session. No foreign key:
      // the epic exists before the engine pushes the session's first record.
      const session = table.string('engine_session_id', 64).nullable()
      // Engine session ids are compared exactly, as in `engine_sessions`.
      if (!isSqlite(this.db)) session.collate('utf8mb4_bin')
      table.json('settings').notNullable()
      table.timestamp('merged_at').nullable()
      table.string('merge_commit', 255).nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['project_id', 'created_at'], 'epics_project_created_idx')
      table.unique(['engine_session_id'], 'epics_engine_session_id_unique')
    })

    this.schema.alterTable('user_stories', (table) => {
      table.json('starts_after').nullable()
      table.string('model_intent', 16).nullable()
      table.json('requested_model').nullable()
      table.uuid('epic_id').nullable()
      table.index(['epic_id'], 'user_stories_epic_id_index')
    })
  }

  async down() {
    this.schema.alterTable('user_stories', (table) => {
      table.dropIndex(['epic_id'], 'user_stories_epic_id_index')
    })
    this.schema.alterTable('user_stories', (table) => {
      table.dropColumn('starts_after')
      table.dropColumn('model_intent')
      table.dropColumn('requested_model')
      table.dropColumn('epic_id')
    })
    this.schema.dropTable('epics')
  }
}
